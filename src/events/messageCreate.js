import { ChannelType, Events } from 'discord.js';
import { EmbedFactory } from '../factories/embedFactory.js';
import { ThreadBlacklistService } from '../services/threadBlacklistService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 处理消息创建事件
 * 检查帖子拉黑列表，对被拉黑用户的消息进行处理
 * @param {Message} message - Discord消息对象
 */
export default {
    name: Events.MessageCreate,
    async execute(message) {
        // 忽略机器人消息
        if (message.author.bot) return;

        // 检查是否在需要自动删除消息的频道中
        const guildConfig = message.client.guildManager?.getGuildConfig(message.guild?.id);
        const autoDeleteChannels = guildConfig?.autoDeleteChannels || [];
        if (autoDeleteChannels.includes(message.channel.id)) {
            // 检查发送者是否有管理权限（管理员或版主）
            const member = message.member;
            const isAdmin = member?.roles.cache.some(role =>
                guildConfig.AdministratorRoleIds?.includes(role.id) ||
                guildConfig.ModeratorRoleIds?.includes(role.id)
            );

            // 如果是管理员，则不删除消息
            if (isAdmin) return;

            await ErrorHandler.handleSilent(
                () => message.delete(),
                '自动删除频道消息'
            );
            return;
        }

        // 检查是否在论坛帖子中
        if (!message.channel.isThread() || message.channel.parent?.type !== ChannelType.GuildForum) {
            return;
        }

        const thread = message.channel;
        const ownerId = thread.ownerId;
        const senderId = message.author.id;

        // 检查该帖子所有者是否有拉黑记录
        const ownersWithBlacklist = ThreadBlacklistService.getOwnersWithBlacklist();
        if (!ownersWithBlacklist.has(ownerId)) {
            return;
        }

        // 检查发送者是否被帖子所有者拉黑
        const blacklistRecord = ThreadBlacklistService.isUserBlacklisted(ownerId, senderId);
        if (!blacklistRecord) {
            return;
        }

        // 发送者被拉黑，执行处理逻辑
        await ErrorHandler.handleSilent(
            async () => {
                // 1. 删除消息
                await message.delete();

                // 2. 获取该帖子的历史违规次数
                const threadViolations = blacklistRecord.threads[thread.id]?.violationCount || 0;

                // 3. 根据违规次数决定处罚
                let muteDuration = 0;
                let muteText = '';
                let shouldNotifyAdmin = false;

                if (threadViolations === 0) {
                    // 首次违规：禁言5分钟
                    muteDuration = 5 * 60 * 1000;
                    muteText = '5分钟';
                } else {
                    // 再次违规：禁言1天
                    muteDuration = 24 * 60 * 60 * 1000;
                    muteText = '1天';
                    shouldNotifyAdmin = true;
                }

                // 4. 执行禁言
                const member = await thread.guild.members.fetch(message.author.id).catch(() => null);
                if (member) {
                    await member.timeout(muteDuration, `在帖子 ${thread.name} 中被拉黑后尝试发言`);
                }

                // 5. 在帖子中发送提示消息
                const embed = EmbedFactory.createBlacklistViolationEmbed(
                    message.author,
                    thread,
                    muteText,
                    threadViolations > 0  // 是否为重复违规
                );
                const embedMessage = await thread.send({ embeds: [embed] });

                // 6. 10秒后删除提示消息
                setTimeout(async () => {
                    await ErrorHandler.handleSilent(
                        () => embedMessage.delete(),
                        '删除拉黑提示消息'
                    );
                }, 10000);

                // 7. 如果需要，发送管理通知
                if (shouldNotifyAdmin) {
                    const guildConfig = message.client.guildManager.getGuildConfig(message.guild.id);
                    if (guildConfig?.punishmentConfirmationChannelId) {
                        await ErrorHandler.handleSilent(
                            async () => {
                                const adminChannel = await message.client.channels.fetch(
                                    guildConfig.punishmentConfirmationChannelId
                                );
                                const adminEmbed = EmbedFactory.createBlacklistAdminNotificationEmbed(
                                    message.author,
                                    thread,
                                    muteText
                                );
                                await adminChannel.send({ embeds: [adminEmbed] });
                            },
                            '发送拉黑违规管理通知'
                        );
                    }
                }

                // 8. 增加违规次数
                const newCounts = ThreadBlacklistService.incrementViolationCount(ownerId, senderId, thread.id);

                logTime(
                    `[用户拉黑] 用户 ${message.author.tag} 在帖子 ${thread.name} 中被拉黑后尝试发言，` +
                    `已删除消息并禁言 ${muteText}` +
                    `（总违规 ${newCounts?.total || 0} 次，本帖 ${newCounts?.thread || 0} 次）`
                );
            },
            '处理被拉黑用户的消息'
        );
    },
};

