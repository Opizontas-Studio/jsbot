import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { handleConfirmationButton } from '../../utils/confirmationHelper.js';
import {
    checkModeratorPermission,
    handleCommandError,
    sendModerationLog,
    sendThreadNotification,
} from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

/**
 * 管理命令 - 管理论坛帖子
 * 提供锁定、解锁、归档、开启、论坛标注等管理功能
 * 注意：标注功能是将帖子标注到论坛顶部，而不是标注帖子内的消息
 */
export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('管理帖子')
        .setDescription('管理论坛帖子')
        .addStringOption(option => option.setName('帖子链接').setDescription('要管理的帖子链接').setRequired(true))
        .addStringOption(option =>
            option
                .setName('操作')
                .setDescription('处理方针（标注为标注帖子到论坛顶部）')
                .setRequired(true)
                .addChoices(
                    { name: '锁定', value: 'lock' },
                    { name: '解锁', value: 'unlock' },
                    { name: '归档', value: 'archive' },
                    { name: '开启', value: 'unarchive' },
                    { name: '论坛标注', value: 'pin' },
                    { name: '取消论坛标注', value: 'unpin' },
                    { name: '删除', value: 'delete' },
                ),
        )
        .addStringOption(option => option.setName('理由').setDescription('处理原因').setRequired(true)),

    async execute(interaction, guildConfig) {
        const threadUrl = interaction.options.getString('帖子链接');

        try {
            // 解析帖子链接
            const matches = threadUrl.match(/channels\/(\d+)\/(\d+)(?:\/threads\/(\d+))?/);

            if (!matches) {
                await interaction.editReply({
                    content: '❌ 无效的帖子链接格式',
                });
                return;
            }

            const [, channelId, threadId] = matches;
            const targetThreadId = threadId || channelId;

            // 获取目标帖子
            const thread = await interaction.guild.channels.fetch(targetThreadId);

            if (!thread || !thread.isThread()) {
                await interaction.editReply({
                    content: '❌ 找不到指定的帖子',
                });
                return;
            }

            // 检查父频道是否为论坛
            const parentChannel = thread.parent;
            if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 此子区不属于论坛频道',
                });
                return;
            }

            // 检查用户权限
            if (
                !(await checkModeratorPermission(interaction, guildConfig, {
                    requireForumPermission: true,
                    customErrorMessage: '❌ 需要管理员权限或（版主权限+该论坛的管理权限）',
                }))
            ) {
                return;
            }

            const action = interaction.options.getString('操作');
            const reason = interaction.options.getString('理由');

            // 处理删除操作
            if (action === 'delete') {
                await handleConfirmationButton({
                    interaction,
                    customId: 'confirm_mod_delete',
                    buttonLabel: '确认删除',
                    embed: {
                        color: 0xff0000,
                        title: '⚠️ 删除确认',
                        description: `你确定要删除帖子 "${
                            thread.name
                        }" 吗？\n\n**⚠️ 警告：此操作不可撤销！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${
                            thread.messageCount
                        }\n删除原因：${reason || '未提供'}`,
                    },
                    onConfirm: async confirmation => {
                        await confirmation.update({
                            content: '⏳ 正在删除帖子...',
                            components: [],
                            embeds: [],
                        });

                        try {
                            const threadName = thread.name;
                            const userTag = interaction.user.tag;
                            const threadOwner = thread.ownerId ? await interaction.client.users.fetch(thread.ownerId).catch(() => null) : null;
                            const ownerTag = threadOwner ? threadOwner.tag : '未知用户';

                            // 发送操作日志
                            await sendModerationLog(interaction.client, guildConfig.threadLogThreadId, {
                                title: `管理员删除帖子`,
                                executorId: interaction.user.id,
                                threadName: thread.name,
                                reason: reason,
                                additionalInfo: `帖子作者: ${ownerTag}`,
                            });

                            await thread.delete(`管理员删除: ${reason}`);

                            // 记录日志
                            logTime(`管理员 ${userTag} 删除了帖子 ${threadName}，原因: ${reason}`);

                            // 尝试发送成功消息
                            try {
                                await confirmation.editReply({
                                    content: `✅ 已成功删除帖子 "${threadName}"`,
                                    components: [],
                                    embeds: [],
                                });
                            } catch (replyError) {
                                // 忽略回复错误，可能是因为命令在被删除的帖子内执行
                            }
                        } catch (error) {
                            // 删除失败时的处理
                            try {
                                await confirmation.editReply({
                                    content: `❌ 删除失败: ${error.message}`,
                                    components: [],
                                    embeds: [],
                                });
                            } catch (replyError) {
                                // 忽略编辑回复时的错误
                                logTime(`删除帖子失败: ${error.message}`, true);
                            }
                            throw error;
                        }
                    },
                    onError: async error => {
                        // 处理错误情况
                        try {
                            await handleCommandError(interaction, error, '删除帖子');
                        } catch (_) {
                            // 忽略错误处理时的错误
                            logTime(`处理删除帖子错误时发生异常: ${error.message}`, true);
                        }
                    },
                });
                return;
            }

            // 执行其他操作
            switch (action) {
                case 'lock':
                    await thread.setLocked(true, reason);
                    break;
                case 'unlock':
                    // 如果帖子已归档，需要先取消归档
                    if (thread.archived) {
                        await thread.setArchived(false, `${reason} - 自动取消归档以解锁帖子`);
                    }
                    await thread.setLocked(false, reason);
                    break;
                case 'archive':
                    await thread.setArchived(true, reason);
                    break;
                case 'unarchive':
                    await thread.setArchived(false, reason);
                    break;
                case 'pin':
                    await thread.pin(reason);
                    break;
                case 'unpin':
                    await thread.unpin(reason);
                    break;
            }

            // 构建操作描述
            const actionDesc = {
                lock: '锁定',
                unlock: '解锁',
                archive: '归档',
                unarchive: '开启',
                pin: '论坛标注',
                unpin: '取消论坛标注',
            }[action];

            // 只有锁定操作才发送日志和通知
            if (action === 'lock') {
            // 发送操作日志
            await sendModerationLog(interaction.client, guildConfig.threadLogThreadId, {
                title: `管理员${actionDesc}帖子`,
                executorId: interaction.user.id,
                threadName: thread.name,
                threadUrl: thread.url,
                reason: reason,
                additionalInfo: thread.ownerId ? `帖子作者: <@${thread.ownerId}>` : undefined,
            });

                // 发送通知
                await sendThreadNotification(thread, {
                    title: `管理员${actionDesc}了此帖`,
                    executorId: interaction.user.id,
                    reason: reason,
                });
            }

            await interaction.editReply({
                content: `✅ 已成功${actionDesc}帖子 "${thread.name}"`,
            });

            logTime(`用户 ${interaction.user.tag} ${actionDesc}了帖子 ${thread.name}`);
        } catch (error) {
            await handleCommandError(interaction, error, '管理帖子');
        }
    },
};
