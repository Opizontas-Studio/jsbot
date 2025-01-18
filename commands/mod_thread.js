import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { checkChannelPermission, sendModerationLog, sendThreadNotification } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

/**
 * 管理命令 - 管理论坛帖子
 * 提供锁定、解锁、归档、开启、论坛标注等管理功能
 * 注意：标注功能是将帖子标注到论坛顶部，而不是标注帖子内的消息
 */
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('管理帖子')
        .setDescription('管理论坛帖子')
        .addStringOption(option =>
            option.setName('帖子链接')
                .setDescription('要管理的帖子链接')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('操作')
                .setDescription('处理方针（标注为标注帖子到论坛顶部）')
                .setRequired(true)
                .addChoices(
                    { name: '锁定', value: 'lock' },
                    { name: '解锁', value: 'unlock' },
                    { name: '归档', value: 'archive' },
                    { name: '开启', value: 'unarchive' },
                    { name: '论坛标注', value: 'pin' },
                    { name: '取消论坛标注', value: 'unpin' }
                )
        )
        .addStringOption(option =>
            option.setName('理由')
                .setDescription('处理原因')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction, guildConfig) {
        const threadUrl = interaction.options.getString('帖子链接');
        
        try {
            // 立即发送一个延迟响应
            await interaction.deferReply({ flags: ['Ephemeral'] });
            
            // 解析帖子链接
            const matches = threadUrl.match(/channels\/(\d+)\/(\d+)(?:\/threads\/(\d+))?/);
            
            if (!matches) {
                await interaction.editReply({
                    content: '❌ 无效的帖子链接格式'
                });
                return;
            }

            const [, guildId, channelId, threadId] = matches;
            const targetThreadId = threadId || channelId;
            
            // 获取目标帖子
            const thread = await interaction.guild.channels.fetch(targetThreadId);
            
            if (!thread || !thread.isThread()) {
                await interaction.editReply({
                    content: '❌ 找不到指定的帖子'
                });
                return;
            }

            // 检查用户是否有执行权限
            const hasPermission = checkChannelPermission(
                interaction.member,
                thread,
                guildConfig.AdministratorRoleIds
            );
            
            if (!hasPermission) {
                await interaction.editReply({
                    content: '你没有权限管理此帖子。需要具有该论坛的消息管理权限。'
                });
                return;
            }

            // 检查父频道是否为论坛
            const parentChannel = thread.parent;
            if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 此子区不属于论坛频道'
                });
                return;
            }

            const action = interaction.options.getString('操作');
            const reason = interaction.options.getString('理由');

            // 执行操作
            let actionResult;
            switch (action) {
                case 'lock':
                    actionResult = await thread.setLocked(true, reason);
                    break;
                case 'unlock':
                    actionResult = await thread.setLocked(false, reason);
                    break;
                case 'archive':
                    actionResult = await thread.setArchived(true, reason);
                    break;
                case 'unarchive':
                    actionResult = await thread.setArchived(false, reason);
                    break;
                case 'pin':
                    actionResult = await thread.pin(reason);
                    break;
                case 'unpin':
                    actionResult = await thread.unpin(reason);
                    break;
            }

            // 构建操作描述
            const actionDesc = {
                lock: '锁定',
                unlock: '解锁',
                archive: '归档',
                unarchive: '开启',
                pin: '论坛标注',
                unpin: '取消论坛标注'
            }[action];

            // 只有锁定和解锁操作才发送日志和通知
            if (action === 'lock' || action === 'unlock') {
                // 发送操作日志
                await sendModerationLog(interaction.client, guildConfig.moderationLogThreadId, {
                    title: `管理员${actionDesc}帖子`,
                    executorId: interaction.user.id,
                    threadName: thread.name,
                    threadUrl: thread.url,
                    reason: reason
                });

                // 发送通知
                await sendThreadNotification(thread, {
                    title: `管理员${actionDesc}了此帖`,
                    executorId: interaction.user.id,
                    reason: reason
                });
            }

            // 使用 editReply 而不是 reply
            await interaction.editReply({
                content: `✅ 已成功${actionDesc}帖子 "${thread.name}"`
            });

            logTime(`用户 ${interaction.user.tag} ${actionDesc}了帖子 ${thread.name}`);

        } catch (error) {
            logTime(`管理帖子时出错: ${error}`, true);
            // 使用 editReply 处理错误
            if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ 执行操作时出错: ${error.message}`
                });
            } else {
                await interaction.reply({
                    content: `❌ 执行操作时出错: ${error.message}`,
                    ephemeral: true
                });
            }
        }
    },
}; 