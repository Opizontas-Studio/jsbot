import { SlashCommandBuilder } from 'discord.js';
import { SelectMenuFactory } from '../../factories/selectMenuFactory.js';
import {
    handleCleanInactiveUsers,
    handleDeleteThread,
    handleLockThread,
    updateSlowMode,
    validateForumThread,
    validateThreadOwner
} from '../../services/selfManageService.js';
import { UserBlacklistService } from '../../services/userBlacklistService.js';
import { delay } from '../../utils/concurrency.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('自助管理')
        .setDescription('管理你自己的帖子，命令在当前帖子生效')
        .addSubcommand(subcommand => subcommand.setName('删贴').setDescription('删除你的当前这个帖子'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('锁定并关闭')
                .setDescription('锁定并关闭你的帖子（沉底并关闭其他人的回复权限）')
                .addStringOption(option => option.setName('理由').setDescription('锁定原因').setRequired(false)),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('清理不活跃用户')
                .setDescription('清理当前帖子中的不活跃用户')
                .addIntegerOption(option =>
                    option
                        .setName('阈值')
                        .setDescription('目标人数阈值（默认950，最低800）')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false),
                )
                .addBooleanOption(option =>
                    option
                        .setName('启用自动清理')
                        .setDescription('是否启用自动清理功能（默认为是）')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('编辑慢速模式')
                .setDescription('修改当前帖子的慢速模式')
                .addStringOption(option =>
                    option
                        .setName('速度')
                        .setDescription('慢速模式时间间隔')
                        .setRequired(true)
                        .addChoices(
                            { name: '无慢速', value: '0' },
                            { name: '5秒', value: '5' },
                            { name: '10秒', value: '10' },
                            { name: '15秒', value: '15' },
                            { name: '30秒', value: '30' },
                            { name: '1分钟', value: '60' }
                        )
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('移除帖子反应')
                .setDescription('移除你的帖子首楼消息上的反应，切记谨慎操作！')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('标注信息')
                .setDescription('标注或取消标注一条消息，注意此功能现在推荐通过上下文菜单进行！')
                .addStringOption(option =>
                    option
                        .setName('消息链接')
                        .setDescription('要标注的消息链接')
                        .setRequired(true),
                )
                .addStringOption(option =>
                    option
                        .setName('操作')
                        .setDescription('选择标注或取消标注')
                        .setRequired(true)
                        .addChoices({ name: '标注', value: 'pin' }, { name: '取消标注', value: 'unpin' }),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('拉黑用户')
                .setDescription('全局拉黑指定用户，该用户将无法在你的所有帖子中发言')
                .addUserOption(option =>
                    option
                        .setName('目标用户')
                        .setDescription('要拉黑的用户')
                        .setRequired(true),
                ),
        ),

    async execute(interaction, guildConfig) {
        const subcommand = interaction.options.getSubcommand();
        const thread = interaction.channel;

        // 检查是否在论坛帖子中使用
        const forumValidation = validateForumThread(thread);
        if (!forumValidation.isValid) {
            await interaction.editReply({
                content: forumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为帖子作者
        const ownerValidation = validateThreadOwner(thread, interaction.user.id);
        if (!ownerValidation.isValid) {
            await interaction.editReply({
                content: ownerValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 使用switch处理不同的子命令
        switch (subcommand) {
            case '删贴':
                await ErrorHandler.handleSilent(
                    async () => await handleDeleteThread(interaction, thread),
                    '删除帖子处理'
                );
                break;

            case '锁定并关闭':
                const reason = interaction.options.getString('理由');
                await ErrorHandler.handleSilent(
                    async () => await handleLockThread(interaction, thread, reason),
                    '锁定帖子处理'
                );
                break;

            case '清理不活跃用户':
                const threshold = interaction.options.getInteger('阈值') || 950;
                const enableAutoCleanup = interaction.options.getBoolean('启用自动清理') ?? true;

                await ErrorHandler.handleSilent(
                    async () => await handleCleanInactiveUsers(interaction, thread, guildConfig, threshold, enableAutoCleanup),
                    '清理不活跃用户处理'
                );
                break;

            case '编辑慢速模式':
                const speed = interaction.options.getString('速度');
                if (!speed || !['0', '5', '10', '15', '30', '60'].includes(speed)) {
                    await interaction.editReply({
                        content: '❌ 无效的速度选择',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                await ErrorHandler.handleInteraction(
                    interaction,
                    async () => {
                        await updateSlowMode(thread, parseInt(speed), interaction.user);
                    },
                    '更新帖子慢速模式',
                    {
                        ephemeral: false,
                        successMessage: '帖子慢速模式已更新'
                    }
                );
                break;

            case '移除帖子反应':
                await ErrorHandler.handleInteraction(
                    interaction,
                    async () => {
                        const starterMessage = await thread.fetchStarterMessage();

                        if (!starterMessage) {
                            throw new Error('无法获取帖子首楼消息');
                        }

                        if (starterMessage.reactions.cache.size === 0) {
                            throw new Error('帖子首楼没有任何反应');
                        }

                        const row = SelectMenuFactory.createReactionRemovalMenu(starterMessage, interaction.user.id);

                        await interaction.editReply({
                            content: '请选择要移除的反应：',
                            components: [row],
                            flags: ['Ephemeral'],
                        });

                        logTime(`[自助管理] 楼主 ${interaction.user.tag} 请求移除帖子 ${thread.name} 首楼的反应`);
                    },
                    '移除帖子反应',
                    { ephemeral: true }
                );
                break;
            case '标注信息':
                try {
                    const messageUrl = interaction.options.getString('消息链接');
                    const action = interaction.options.getString('操作');

                    const matches = messageUrl.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
                    if (!matches) {
                        await interaction.editReply({
                            content: '❌ 无效的消息链接格式',
                        });
                        return;
                    }

                    const [, guildId, channelId, messageId] = matches;

                    // 验证消息是否在当前服务器
                    if (guildId !== interaction.guildId) {
                        await interaction.editReply({
                            content: '❌ 只能标注当前服务器的消息',
                        });
                        return;
                    }

                    // 验证消息是否在当前帖子
                    if (channelId !== interaction.channelId) {
                        await interaction.editReply({
                            content: '❌ 只能标注当前帖子内的消息',
                        });
                        return;
                    }

                    try {
                        const message = await interaction.channel.messages.fetch(messageId);

                        if (!message) {
                            await interaction.editReply({
                                content: '❌ 找不到指定的消息',
                            });
                            return;
                        }

                        if (action === 'pin') {
                            await message.pin();
                            await interaction.editReply({
                                content: '✅ 消息已标注，注意此功能现在推荐通过上下文菜单更加方便快捷，请点击这里了解如何使用：https://discord.com/channels/1291925535324110879/1338165171432194118',
                            });
                            logTime(`[自助管理] 楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                        } else {
                            await message.unpin();
                            await interaction.editReply({
                                content: '✅ 消息已取消标注，注意此功能现在推荐通过上下文菜单更加方便快捷，请点击这里了解如何使用：https://discord.com/channels/1291925535324110879/1338165171432194118',
                            });
                            logTime(`[自助管理] 楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                        }
                    } catch (error) {
                        await interaction.editReply({
                            content: `❌ 标注操作失败: ${error.message}`,
                        });
                        throw error;
                    }
                } catch (error) {
                    await handleCommandError(interaction, error, '标注消息');
                }
                break;

            case '拉黑用户':
                const targetUser = interaction.options.getUser('目标用户');

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

                // 检查目标用户是否为管理员
                const moderatorRoles = guildConfig.ModeratorRoleIds || [];
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
                if (UserBlacklistService.isUserBlacklisted(thread.ownerId, targetUser.id)) {
                    await interaction.editReply({
                        content: `⚠️ 用户 ${targetUser.tag} 已被你全局拉黑`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 执行拉黑操作
                await ErrorHandler.handleInteraction(
                    interaction,
                    async () => {
                        await interaction.editReply({
                            content: `⏳ 正在处理拉黑 ${targetUser.tag}...\n正在扫描消息...`,
                            flags: ['Ephemeral'],
                        });

                        // 扫描并删除消息（分10批，每批100条）
                        const BATCH_SIZE = 100;
                        const BATCHES = 10;
                        let totalScanned = 0;
                        let totalDeleted = 0;
                        let lastMessageId = null;

                        for (let batch = 0; batch < BATCHES; batch++) {
                            // 获取消息
                            const options = { limit: BATCH_SIZE };
                            if (lastMessageId) options.before = lastMessageId;

                            const messages = await thread.messages.fetch(options);
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

                        // 添加到全局拉黑列表
                        UserBlacklistService.addUserToBlacklist(thread.ownerId, targetUser.id);

                        await interaction.editReply({
                            content: `✅ 已全局拉黑用户 ${targetUser.tag}\n- 扫描了 ${totalScanned} 条消息\n- 删除了 ${totalDeleted} 条该用户的消息\n⚠️ 该用户将无法在你的所有帖子中发言`,
                            flags: ['Ephemeral'],
                        });

                        logTime(`[自助管理] ${interaction.user.tag} 全局拉黑了 ${targetUser.tag}，在帖子 ${thread.name} 中删除了 ${totalDeleted} 条消息`);
                    },
                    '拉黑用户',
                    { ephemeral: true }
                );
                break;
        }
    },
};
