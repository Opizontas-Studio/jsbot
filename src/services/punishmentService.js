import { PunishmentModel } from '../db/models/punishmentModel.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { logTime } from '../utils/logger.js';
import {
    executePunishmentAction,
    formatPunishmentDuration,
    sendBanNotification,
    sendChannelNotification,
    sendModLogNotification,
    sendMuteNotification,
} from '../utils/punishmentHelper.js';
import { BlacklistService } from './blacklistService.js';

class PunishmentService {
    /**
     * 执行处罚
     * @param {Object} client - Discord客户端
     * @param {Object} data - 处罚数据
     * @param {string} executingGuildId - 执行处罚的服务器ID
     * @returns {Promise<{success: boolean, message: string}>}
     */
    static async executePunishment(client, data, executingGuildId) {
        try {
            // 1. 获取关键信息
            const executor = await client.users.fetch(data.executorId);
            const target = await client.users.fetch(data.userId);
            if (!executor || !target) {
                throw new Error('无法获取用户信息');
            }

            // 2. 创建处罚记录
            const punishment = await PunishmentModel.createPunishment(data);

            // 如果存在投票信息，手动合并到punishment对象中
            if (data.voteInfo) {
                punishment.voteInfo = data.voteInfo;
            }

            // 记录基本信息
            logTime(
                `处罚信息 - 处罚ID: ${punishment.id}, ` +
                    `执行者: ${executor.tag}, ` +
                    `目标: ${target.tag}, ` +
                    `类型: ${punishment.type}, ` +
                    `原因: ${punishment.reason}, ` +
                    `禁言时长: ${formatPunishmentDuration(punishment.duration)}, ` +
                    `警告时长: ${
                        punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '无'
                    }`,
            );

            // 3. 如果是永封处罚，先发送私信通知
            if (punishment.type === 'ban') {
                const success = await sendBanNotification(target, punishment);
                if (success) {
                    logTime(`已向用户 ${target.tag} 发送永封通知`);
                } else {
                    logTime(`无法向用户 ${target.tag} 发送永封通知`, true);
                }
            }

            // 4. 在指定服务器执行处罚
            const guildData = client.guildManager.getGuildConfig(executingGuildId);
            if (!guildData) {
                // 删除处罚记录
                await PunishmentModel.deletePunishment(punishment.id);
                logTime(`指定的服务器 ${executingGuildId} 配置不存在，已删除处罚记录 ${punishment.id}`);
                return {
                    success: false,
                    message: '❌ 处罚执行失败：指定的服务器配置不存在',
                };
            }

            const guild = await client.guilds.fetch(executingGuildId).catch(() => null);
            if (!guild) {
                // 删除处罚记录
                await PunishmentModel.deletePunishment(punishment.id);
                logTime(`无法获取服务器 ${executingGuildId}，已删除处罚记录 ${punishment.id}`);
                return {
                    success: false,
                    message: '❌ 处罚执行失败：无法获取指定的服务器',
                };
            }

            // 执行处罚
            const success = await executePunishmentAction(guild, punishment);
            if (!success) {
                // 删除处罚记录
                await PunishmentModel.deletePunishment(punishment.id);
                logTime(`在服务器 ${guild.name} 执行处罚失败，已删除处罚记录 ${punishment.id}`);
                return {
                    success: false,
                    message: `❌ 处罚执行失败：在服务器 ${guild.name} 执行处罚失败`,
                };
            }

            // 5. 更新同步状态
            await PunishmentModel.updateSyncStatus(punishment.id, [executingGuildId]);

            // 6. 将用户添加到黑名单
            try {
                await BlacklistService.addUserToBlacklistImmediately(punishment.userId);
            } catch (error) {
                logTime(`[处罚] 添加用户 ${punishment.userId} 到黑名单失败: ${error.message}`, true);
                // 不影响处罚的执行，继续执行
            }

            // 如果是永封，标记为过期
            if (punishment.type === 'ban') {
                await PunishmentModel.updateStatus(punishment.id, 'expired', '已在指定服务器执行永封');
                logTime(`永封处罚 ${punishment.id} 已在服务器 ${guild.name} 执行完毕，标记为过期`);
            }

            // 设置处罚到期定时器
            if (punishment.duration > 0 || punishment.warningDuration) {
                try {
                    await globalTaskScheduler.getPunishmentScheduler().schedulePunishment(punishment, client);
                } catch (error) {
                    logTime(`设置处罚到期定时器失败: ${error.message}`, true);
                    // 不抛出错误，继续执行
                }
            }

            // 7. 发送通知
            const notificationResults = [];

            // 如果有指定频道，发送频道通知
            if (data.channelId) {
                try {
                    const channel = await client.channels.fetch(data.channelId);
                    if (channel && channel.guild.id === executingGuildId) {
                        const success = await sendChannelNotification(channel, target, punishment);
                        if (success) {
                            notificationResults.push(`服务器 ${guild.name} 的频道通知`);
                        }
                    }
                } catch (error) {
                    logTime(`发送频道通知失败: ${error.message}`, true);
                }
            }

            // 发送管理日志
            if (guildData.moderationLogThreadId) {
                try {
                    const logChannel = await client.channels.fetch(guildData.moderationLogThreadId).catch(() => null);
                    if (logChannel) {
                        const notificationResult = await sendModLogNotification(logChannel, punishment, executor, target);
                        if (notificationResult.success) {
                            await PunishmentModel.updateNotificationInfo(
                                punishment.id,
                                notificationResult.messageId,
                                notificationResult.guildId,
                            );
                            notificationResults.push(`服务器 ${guild.name} 的管理日志`);
                        }
                    }
                } catch (error) {
                    logTime(`发送管理日志通知失败: ${error.message}`, true);
                }
            }

            // 发送禁言私信通知
            if (punishment.type === 'mute' && data.channelId && !data.noAppeal) {
                try {
                    const channel = await client.channels.fetch(data.channelId);
                    if (channel && channel.guild.id === executingGuildId) {
                        const success = await sendMuteNotification(channel, target, punishment);
                        if (success) {
                            notificationResults.push(`服务器 ${guild.name} 的私信通知`);
                        }
                    }
                } catch (error) {
                    logTime(`发送私信通知失败: ${error.message}`, true);
                }
            }

            if (notificationResults.length > 0) {
                logTime(`通知发送情况 - 已发送: ${notificationResults.join(', ')}`);
            } else {
                logTime('通知发送情况 - 无通知发送成功', true);
            }

            // 7. 返回执行结果
            return {
                success: true,
                message: `✅ 处罚已在服务器 ${guild.name} 执行成功`,
            };
        } catch (error) {
            logTime(`执行处罚失败: ${error.message}`, true);
            if (error.stack) {
                logTime(`错误堆栈: ${error.stack}`, true);
            }
            return {
                success: false,
                message: `❌ 执行处罚失败: ${error.message}`,
            };
        }
    }

    /**
     * 处理处罚到期
     * @param {Object} client - Discord客户端
     * @param {Object} punishment - 处罚记录
     */
    static async handleExpiry(client, punishment) {
        try {
            const now = Date.now();
            const muteExpired = punishment.duration > 0 && punishment.createdAt + punishment.duration <= now;
            const warningExpired =
                punishment.warningDuration > 0 && punishment.createdAt + punishment.warningDuration <= now;

            // 处理警告到期
            if (warningExpired && punishment.warningDuration) {
                // 检查用户是否还有其他活跃的警告处罚
                const userId = punishment.userId;
                const otherActivePunishments = await PunishmentModel.getUserPunishments(userId, false);
                const hasOtherActiveWarnings = otherActivePunishments.some(
                    p => p.id !== punishment.id && p.warningDuration && p.createdAt + p.warningDuration > now,
                );

                // 只有在没有其他活跃警告处罚时才移除警告身份组
                if (!hasOtherActiveWarnings) {
                    // 遍历所有配置的服务器
                    const allGuilds = Array.from(client.guildManager.guilds.values());

                    for (const guildData of allGuilds) {
                        try {
                            if (!guildData || !guildData.id || !guildData.roleApplication?.WarnedRoleId) {
                                logTime(`服务器 ${guildData?.id || 'unknown'} 配置不完整，跳过`, true);
                                continue;
                            }

                            const guild = await client.guilds.fetch(guildData.id).catch(error => {
                                logTime(`获取服务器失败: ${error.message}`, true);
                                return null;
                            });

                            const member = await guild.members.fetch(punishment.userId).catch(() => null);
                            if (!member) {
                                logTime(`无法在服务器 ${guild.name} 找到目标用户，跳过`, true);
                                continue;
                            }

                            if (member.roles.cache.has(guildData.roleApplication?.WarnedRoleId)) {
                                await member.roles
                                    .remove(guildData.roleApplication?.WarnedRoleId, '警告已到期')
                                    .then(() => {
                                        logTime(
                                            `已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的警告身份组 (处罚ID: ${punishment.id}, 原因: ${punishment.reason})`,
                                        );
                                    })
                                    .catch(error => {
                                        logTime(
                                            `在服务器 ${guild.name} 移除用户 ${member.user.tag} 的警告身份组失败: ${error.message}`,
                                            true,
                                        );
                                    });
                            } else {
                                logTime(`用户 ${member.user.tag} 在服务器 ${guild.name} 没有警告身份组，无需移除`);
                            }
                        } catch (error) {
                            logTime(`处理服务器 ${guildData?.id || 'unknown'} 的警告到期失败: ${error.message}`, true);
                        }
                    }
                } else {
                    logTime(`用户 ${punishment.userId} 还有其他活跃的警告处罚，保留警告身份组`);
                }
            }

            // 只有当禁言和警告都到期时，才更新状态为已过期
            if ((muteExpired && punishment.type === 'mute') || warningExpired) {
                await PunishmentModel.updateStatus(punishment.id, 'expired', '处罚已到期');
                logTime(`处罚 ${punishment.id} 状态已更新为已过期`);
            }
        } catch (error) {
            logTime(`处理处罚到期失败 [ID: ${punishment.id}]: ${error.message}`, true);
            throw error;
        }
    }
}

export default PunishmentService;
