import { PunishmentModel } from '../db/models/punishmentModel.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { logTime } from '../utils/logger.js';
import {
    executePunishmentAction,
    formatPunishmentDuration,
    sendAppealNotification,
    sendModLogNotification,
} from '../utils/punishmentHelper.js';

class PunishmentService {
    /**
     * 执行处罚
     * @param {Object} client - Discord客户端
     * @param {Object} data - 处罚数据
     * @returns {Promise<{success: boolean, message: string}>}
     */
    static async executePunishment(client, data) {
        try {
            // 1. 获取关键信息
            const executor = await client.users.fetch(data.executorId);
            const target = await client.users.fetch(data.userId);
            if (!executor || !target) {
                throw new Error('无法获取用户信息');
            }

            // 2. 创建处罚记录
            const punishment = await PunishmentModel.createPunishment(data);
            // 记录基本信息
            logTime(
                `处罚信息 - 处罚ID: ${punishment.id}, ` +
                `执行者: ${executor.tag}, ` +
                `目标: ${target.tag}, ` +
                `类型: ${punishment.type}, ` +
                `原因: ${punishment.reason}, ` +
                `禁言时长: ${formatPunishmentDuration(punishment.duration)}, ` +
                `警告时长: ${punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '无'}`
            );

            // 3. 如果是永封处罚，先发送私信通知
            if (punishment.type === 'ban') {
                try {
                    await target.send({
                        content: [
                            '⚠️ **永封通知**',
                            '您已被永久封禁：',
                            `• 原因：${punishment.reason}`,
                            `• 执行时间：<t:${Math.floor(Date.now() / 1000)}:F>`,
                            `• 执行管理员：${executor.tag}`,
                            '您将被立即移出所有相关服务器。'
                        ].join('\n')
                    });
                    logTime(`已向用户 ${target.tag} 发送永封通知`);
                } catch (error) {
                    logTime(`无法向用户 ${target.tag} 发送永封通知: ${error.message}`, true);
                }
            }

            // 4. 遍历所有服务器执行处罚
            const successfulServers = [];
            const failedServers = [];
            const allGuilds = Array.from(client.guildManager.guilds.values());

            for (const guildData of allGuilds) {
                try {
                    if (!guildData || !guildData.id) {
                        logTime('跳过无效的服务器配置', true);
                        continue;
                    }

                    const guild = await client.guilds.fetch(guildData.id).catch(() => null);
                    if (!guild) {
                        logTime(`无法获取服务器 ${guildData.id}`, true);
                        failedServers.push({
                            id: guildData.id,
                            name: guildData.name || guildData.id,
                        });
                        continue;
                    }

                    // 执行处罚
                    const success = await executePunishmentAction(guild, punishment);
                    if (success) {
                        successfulServers.push({
                            id: guild.id,
                            name: guild.name,
                        });
                        logTime(`在服务器 ${guild.name} 执行处罚成功`);
                    } else {
                        failedServers.push({
                            id: guild.id,
                            name: guild.name,
                        });
                        logTime(`在服务器 ${guild.name} 执行处罚失败`, true);
                    }
                } catch (error) {
                    failedServers.push({
                        id: guildData.id,
                        name: guildData.name || guildData.id,
                    });
                    logTime(`在服务器 ${guildData.id} 执行处罚时发生错误: ${error.message}`, true);
                }
            }

            // 如果所有服务器都执行失败
            if (successfulServers.length === 0) {
                // 删除处罚记录
                await PunishmentModel.deletePunishment(punishment.id);
                logTime(`所有服务器处罚执行失败，已删除处罚记录 ${punishment.id}`);
                return {
                    success: false,
                    message: '❌ 处罚执行失败：无法在任何服务器执行处罚',
                };
            }

            // 记录执行结果
            logTime(`处罚执行情况 - 成功: ${successfulServers.map(s => s.name).join(', ')}`);
            if (failedServers.length > 0) {
                logTime(`处罚执行情况 - 失败: ${failedServers.map(s => s.name).join(', ')}`, true);
            }

            // 5. 更新同步状态
            if (successfulServers.length > 0) {
                const syncedServerIds = successfulServers.map(s => s.id);
                await PunishmentModel.updateSyncStatus(punishment.id, syncedServerIds);

                // 如果是永封且已同步到所有服务器，则标记为过期
                if (punishment.type === 'ban') {
                    const allGuildIds = client.guildManager.getGuildIds();
                    if (allGuildIds.every(guildId => syncedServerIds.includes(guildId))) {
                        await PunishmentModel.updateStatus(punishment.id, 'expired', '已在所有服务器执行永封');
                        logTime(`永封处罚 ${punishment.id} 已在所有服务器执行完毕，标记为过期`);
                    }
                }
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

            // 6. 发送通知
            const notificationResults = [];
            // 发送管理日志
            for (const guildData of allGuilds) {
                if (guildData.moderationLogThreadId) {
                    try {
                        const logChannel = await client.channels
                            .fetch(guildData.moderationLogThreadId)
                            .catch(() => null);
                        if (logChannel) {
                            const success = await sendModLogNotification(logChannel, punishment, executor, target);
                            if (success) {
                                const guildName = logChannel.guild?.name || '未知服务器';
                                notificationResults.push(`服务器 ${guildName} 的管理日志`);
                            }
                        }
                    } catch (error) {
                        logTime(`发送管理日志通知失败 (服务器ID: ${guildData.id}): ${error.message}`, true);
                    }
                }
            }

            // 发送禁言上诉通知
            if (punishment.type === 'mute' && data.channelId) {
                try {
                    const channel = await client.channels.fetch(data.channelId);
                    if (channel) {
                        const success = await sendAppealNotification(channel, target, punishment);
                        if (success) {
                            const guildName = channel.guild?.name || '未知服务器';
                            notificationResults.push(`服务器 ${guildName} 的上诉通知`);
                        }
                    }
                } catch (error) {
                    logTime(`发送上诉通知失败: ${error.message}`, true);
                }
            }

            if (notificationResults.length > 0) {
                logTime(`通知发送情况 - 已发送: ${notificationResults.join(', ')}`);
            } else {
                logTime('通知发送情况 - 无通知发送成功', true);
            }

            // 6. 返回执行结果
            return {
                success: true,
                message: [
                    '✅ 处罚执行结果：',
                    `成功服务器: ${successfulServers.length > 0 ? successfulServers.map(s => s.name).join(', ') : '无'}`,
                    failedServers.length > 0 ? `失败服务器: ${failedServers.map(s => s.name).join(', ')}` : null,
                ]
                    .filter(Boolean)
                    .join('\n'),
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
            const warningExpired = punishment.warningDuration > 0 && punishment.createdAt + punishment.warningDuration <= now;

            // 处理禁言到期
            if (muteExpired && punishment.type === 'mute') {
                logTime(`禁言处罚 ${punishment.id} 已到期`);
            }

            // 处理警告到期
            if (warningExpired && punishment.warningDuration) {
                // 遍历所有配置的服务器
                const allGuilds = Array.from(client.guildManager.guilds.values());

                for (const guildData of allGuilds) {
                    try {
                        if (!guildData || !guildData.id || !guildData.WarnedRoleId) {
                            logTime(`服务器 ${guildData?.id || 'unknown'} 配置不完整，跳过`, true);
                            continue;
                        }

                        const guild = await client.guilds.fetch(guildData.id).catch(error => {
                            logTime(`获取服务器失败: ${error.message}`, true);
                            return null;
                        });

                        if (!guild) {
                            logTime(`无法获取服务器 ${guildData.id} 的信息，跳过`, true);
                            continue;
                        }

                        const member = await guild.members.fetch(punishment.userId).catch(() => null);
                        if (!member) {
                            logTime(`无法在服务器 ${guild.name} 找到目标用户，跳过`, true);
                            continue;
                        }

                        if (member.roles.cache.has(guildData.WarnedRoleId)) {
                            await member.roles
                                .remove(guildData.WarnedRoleId, '警告已到期')
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
            }

            // 只有当禁言和警告都到期时，才更新状态为已过期
            if ((muteExpired && punishment.type === 'mute') || warningExpired) {
                await PunishmentModel.updateStatus(punishment.id, 'expired', '处罚已到期');
                logTime(`处罚 ${punishment.id} 状态已更新为已到期`);
            }
        } catch (error) {
            logTime(`处理处罚到期失败 [ID: ${punishment.id}]: ${error.message}`, true);
            throw error;
        }
    }
}

export default PunishmentService;
