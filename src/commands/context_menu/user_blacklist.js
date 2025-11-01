import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { validateForumThread } from '../../services/selfManageService.js';
import { ThreadBlacklistService } from '../../services/threadBlacklistService.js';
import { delay } from '../../utils/concurrency.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('拉黑用户')
        .setType(ApplicationCommandType.User),

    async execute(interaction, guildConfig) {
        const channel = interaction.channel;
        const targetUser = interaction.targetUser;

        // 判断是否在论坛帖子中
        const isInThread = channel.isThread();
        const forumValidation = isInThread ? validateForumThread(channel) : { isValid: false };
        const isInForumThread = forumValidation.isValid;

        // 确定拉黑关系的创建者
        // 在论坛帖子中：帖子作者（无论谁操作）
        // 在其他地方：操作者自己
        const blacklistOwnerId = isInForumThread ? channel.ownerId : interaction.user.id;

        // 权限检查
        const moderatorRoles = guildConfig.ModeratorRoleIds || [];
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const isModerator = member.roles.cache.some(role => moderatorRoles.includes(role.id));

        if (isInForumThread) {
            // 在论坛帖子中，需要是帖子作者或管理员
            const isOwner = channel.ownerId === interaction.user.id;
            if (!isOwner && !isModerator) {
                await interaction.editReply({
                    content: '❌ 只有帖子作者或管理员才能拉黑用户',
                    flags: ['Ephemeral'],
                });
                return;
            }
        }
        // 在其他地方，任何人都可以使用（拉黑自己和目标用户的关系）

        // 检查目标用户
        if (targetUser.id === interaction.user.id) {
            await interaction.editReply({
                content: '❌ 不能拉黑自己',
                flags: ['Ephemeral'],
            });
            return;
        }

        if (targetUser.bot) {
            await interaction.editReply({
                content: '❌ 不能拉黑机器人',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查目标用户是否为帖子作者（仅在论坛帖子中检查）
        if (isInForumThread && targetUser.id === channel.ownerId) {
            await interaction.editReply({
                content: '❌ 不能拉黑帖子作者',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查目标用户是否为管理员
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (targetMember) {
            const hasModRole = targetMember.roles.cache.some(role => moderatorRoles.includes(role.id));
            if (hasModRole) {
                await interaction.editReply({
                    content: '❌ 不能拉黑管理员',
                    flags: ['Ephemeral'],
                });
                return;
            }
        }

        // 检查是否已经在拉黑列表中
        if (ThreadBlacklistService.isUserBlacklisted(blacklistOwnerId, targetUser.id)) {
            const ownerText = isInForumThread ? '帖子作者' : '你';
            await interaction.editReply({
                content: `⚠️ 用户 ${targetUser.tag} 已被${ownerText}全局拉黑`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 执行拉黑操作
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                if (isInForumThread) {
                    // 在论坛帖子中，扫描并删除消息
                    await interaction.editReply({
                        content: `⏳ 正在处理拉黑 ${targetUser.tag}...\n正在扫描消息...`,
                        flags: ['Ephemeral'],
                    });

                    // 扫描并删除消息（分10批，每批100条）
                    const MAX_MESSAGES = 1000;
                    const BATCH_SIZE = 100;
                    const BATCHES = 10;
                    let totalScanned = 0;
                    let totalDeleted = 0;
                    let lastMessageId = null;

                    for (let batch = 0; batch < BATCHES; batch++) {
                        // 获取消息
                        const options = { limit: BATCH_SIZE };
                        if (lastMessageId) options.before = lastMessageId;

                        const messages = await channel.messages.fetch(options);
                        if (messages.size === 0) break;

                        totalScanned += messages.size;
                        lastMessageId = messages.last().id;

                        // 筛选目标用户的消息
                        const targetMessages = messages.filter(msg => msg.author.id === targetUser.id);

                        // 删除消息（每条间隔1秒）
                        for (const msg of targetMessages.values()) {
                            try {
                                await msg.delete();
                                totalDeleted++;
                                await delay(1000);
                            } catch (error) {
                                logTime(`[帖子拉黑] 删除消息失败: ${error.message}`, true);
                            }
                        }

                        // 更新进度
                        await interaction.editReply({
                            content: `⏳ 正在处理拉黑 ${targetUser.tag}...\n已扫描 ${totalScanned} 条消息，已删除 ${totalDeleted} 条`,
                            flags: ['Ephemeral'],
                        });

                        // 批次间延迟1秒
                        if (batch < BATCHES - 1) {
                            await delay(1000);
                        }
                    }

                    // 移出用户
                    try {
                        await channel.members.remove(targetUser.id);
                    } catch (error) {
                        logTime(`[帖子拉黑] 移出用户失败: ${error.message}`, true);
                    }

                    // 添加到全局拉黑列表
                    ThreadBlacklistService.addUserToBlacklist(blacklistOwnerId, targetUser.id);

                    const ownerText = channel.ownerId === interaction.user.id ? '你' : '帖子作者';
                    await interaction.editReply({
                        content: `✅ 已全局拉黑用户 ${targetUser.tag}\n- 扫描了 ${totalScanned} 条消息\n- 删除了 ${totalDeleted} 条该用户的消息\n- 已将用户移出子区\n\n⚠️ 该用户将无法在${ownerText}的所有帖子中发言`,
                        flags: ['Ephemeral'],
                    });

                    logTime(`[用户拉黑] ${interaction.user.tag} 为 ${channel.ownerId === interaction.user.id ? '自己' : '帖子作者'} 全局拉黑了 ${targetUser.tag}，在帖子 ${channel.name} 中删除了 ${totalDeleted} 条消息`);
                } else {
                    // 在其他地方，只添加拉黑关系，不扫描消息
                    ThreadBlacklistService.addUserToBlacklist(blacklistOwnerId, targetUser.id);

                    await interaction.editReply({
                        content: `✅ 已全局拉黑用户 ${targetUser.tag}\n\n⚠️ 该用户将无法在你的所有帖子中发言`,
                        flags: ['Ephemeral'],
                    });

                    logTime(`[用户拉黑] ${interaction.user.tag} 全局拉黑了 ${targetUser.tag}（在非帖子环境）`);
                }
            },
            '拉黑用户',
            { ephemeral: true }
        );
    },
};

