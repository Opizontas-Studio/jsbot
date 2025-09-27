import { PunishmentModel } from '../db/models/punishmentModel.js';
import { EmbedFactory } from '../factories/embedFactory.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { formatPunishmentDuration } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { BlacklistService } from './blacklistService.js';

class PunishmentService {
    /**
     * 检查警告是否仍然有效
     * @param {Object} punishment - 处罚记录
     * @returns {boolean} 警告是否有效
     */
    static isWarningStillValid(punishment) {
        if (!punishment.warningDuration) return false;
        const warningExpiryTime = punishment.createdAt + punishment.warningDuration;
        return warningExpiryTime > Date.now();
    }

    /**
     * 执行处罚
     * @param {Object} client - Discord客户端
     * @param {Object} data - 处罚数据
     * @param {string} executingGuildId - 执行处罚的服务器ID
     * @returns {Promise<{success: boolean, message: string}>}
     */
    static async executePunishment(client, data, executingGuildId) {
        return await ErrorHandler.handleService(
            async () => {
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
                    `[处罚系统] 处罚ID: ${punishment.id}, ` +
                        `执行者: ${executor.tag}, ` +
                        `目标: ${target.tag}, ` +
                        `类型: ${punishment.type}, ` +
                        `原因: ${punishment.reason}, ` +
                        `禁言时长: ${formatPunishmentDuration(punishment.duration)}, ` +
                        `警告时长: ${
                            punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '无'
                        }`,
                );

                // 3. 发送私信通知（可容错）
                await ErrorHandler.handleSilent(
                    async () => {
                        const embed = EmbedFactory.createPunishmentDMEmbed(punishment);
                        await target.send({ embeds: [embed] });
                        logTime(`[处罚系统] 已向用户 ${target.tag} 发送${EmbedFactory.getPunishmentTypeText(punishment.type)}通知`);
                    },
                    `发送私信通知给用户 ${target.tag}`
                );

                // 4. 在指定服务器执行处罚
                const guildData = client.guildManager.getGuildConfig(executingGuildId);
                if (!guildData) {
                    await PunishmentModel.deletePunishment(punishment.id);
                    throw new Error('指定的服务器配置不存在');
                }

                const guild = await client.guilds.fetch(executingGuildId).catch(() => null);
                if (!guild) {
                    await PunishmentModel.deletePunishment(punishment.id);
                    throw new Error('无法获取指定的服务器');
                }

                // 执行处罚
                const success = await PunishmentService.executePunishmentAction(guild, punishment);
                if (!success) {
                    await PunishmentModel.deletePunishment(punishment.id);
                    throw new Error(`在服务器 ${guild.name} 执行处罚失败`);
                }

                // 5. 更新同步状态
                await PunishmentModel.updateSyncStatus(punishment.id, [executingGuildId]);

                // 6. 将用户添加到黑名单（可容错）
                await ErrorHandler.handleSilent(
                    () => BlacklistService.addUserToBlacklistImmediately(punishment.userId),
                    `添加用户 ${punishment.userId} 到黑名单`
                );

                // 7. 根据处罚类型更新状态
                if (punishment.type === 'ban') {
                    await PunishmentModel.updateStatus(punishment.id, 'expired', '已在指定服务器执行永封');
                    logTime(`[处罚系统] 永封处罚 ${punishment.id} 已在服务器 ${guild.name} 执行完毕，标记为过期`);
                } else if (punishment.type === 'softban') {
                    if (!punishment.warningDuration) {
                        await PunishmentModel.updateStatus(punishment.id, 'expired', '已在指定服务器执行软封锁');
                        logTime(`[处罚系统] 软封锁处罚 ${punishment.id} 已在服务器 ${guild.name} 执行完毕，标记为过期`);
                    } else {
                        logTime(`[处罚系统] 软封锁处罚 ${punishment.id} 已在服务器 ${guild.name} 执行完毕，保持活跃状态（有警告期）`);
                    }
                }

                // 8. 设置处罚到期定时器（可容错）
                if (punishment.duration > 0 || punishment.warningDuration) {
                    await ErrorHandler.handleSilent(
                        () => globalTaskScheduler.getScheduler('punishment').schedulePunishment(punishment, client),
                        '设置处罚到期定时器'
                    );
                }

                // 9. 发送通知（可容错）
                const notificationResults = [];

                // 发送频道通知
                if (data.channelId) {
                    const channelResult = await ErrorHandler.handleSilent(
                        async () => {
                            const channel = await client.channels.fetch(data.channelId);
                            if (channel && channel.guild.id === executingGuildId) {
                                const embed = EmbedFactory.createChannelPunishmentEmbed(punishment, target);
                                await channel.send({ embeds: [embed] });
                                return `服务器 ${guild.name} 的频道通知`;
                            }
                            return null;
                        },
                        '发送频道通知'
                    );
                    if (channelResult) notificationResults.push(channelResult);
                }

                // 发送管理日志
                if (guildData.moderationLogThreadId) {
                    const logResult = await ErrorHandler.handleSilent(
                        async () => {
                            const logChannel = await client.channels.fetch(guildData.moderationLogThreadId).catch(() => null);
                            if (logChannel) {
                                const embed = EmbedFactory.createModLogPunishmentEmbed(punishment, target);
                                const message = await logChannel.send({ embeds: [embed] });
                                await PunishmentModel.updateNotificationInfo(
                                    punishment.id,
                                    message.id,
                                    logChannel.guild.id,
                                );
                                return `服务器 ${guild.name} 的管理日志`;
                            }
                            return null;
                        },
                        '发送管理日志通知'
                    );
                    if (logResult) notificationResults.push(logResult);
                }

                if (notificationResults.length > 0) {
                    logTime(`[处罚系统] 通知发送情况 - 已发送: ${notificationResults.join(', ')}`);
                } else {
                    logTime('[处罚系统] 通知发送情况 - 无通知发送成功', true);
                }

                return {
                    success: true,
                    message: `✅ 处罚已在服务器 ${guild.name} 执行成功`,
                };
            },
            '执行处罚',
            { throwOnError: true }
        );
    }

    /**
     * 处理处罚到期
     * @param {Object} client - Discord客户端
     * @param {Object} punishment - 处罚记录
     */
    static async handleExpiry(client, punishment) {
        return await ErrorHandler.handleService(
            async () => {
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
                            if (!guildData?.roleApplication?.WarnedRoleId) continue;

                            const guild = await ErrorHandler.handleSilent(
                                () => client.guilds.fetch(guildData.id),
                                `获取服务器 ${guildData.id}`,
                                null
                            );

                            if (!guild) continue;

                            const member = await ErrorHandler.handleSilent(
                                () => guild.members.fetch(punishment.userId),
                                `获取用户 ${punishment.userId} 在服务器 ${guild.name}`,
                                null
                            );

                            if (!member) continue;

                            if (member.roles.cache.has(guildData.roleApplication?.WarnedRoleId)) {
                                await ErrorHandler.handleSilent(
                                    () => member.roles.remove(guildData.roleApplication?.WarnedRoleId, '警告已到期'),
                                    `移除用户 ${member.user.tag} 在服务器 ${guild.name} 的警告身份组`
                                );
                                logTime(
                                    `[处罚系统] 已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的警告身份组 (处罚ID: ${punishment.id}, 原因: ${punishment.reason})`,
                                );
                            } else {
                                logTime(`[处罚系统] 用户 ${member.user.tag} 在服务器 ${guild.name} 没有警告身份组，无需移除`);
                            }
                        }
                    } else {
                        logTime(`[处罚系统] 用户 ${punishment.userId} 还有其他活跃的警告处罚，保留警告身份组`);
                    }
                }

                // 根据处罚类型更新状态为已过期
                if ((muteExpired && punishment.type === 'mute') ||
                    (warningExpired && punishment.type === 'softban') ||
                    (warningExpired && punishment.type === 'warning')) {
                    await PunishmentModel.updateStatus(punishment.id, 'expired', '处罚已到期');
                }
            },
            `处理处罚到期 [ID: ${punishment.id}]`,
            { throwOnError: true }
        );
    }

    /**
     * 在所有服务器中解除处罚
     * @param {Object} client - Discord客户端
     * @param {Object} punishment - 处罚记录
     * @param {Object} target - 目标用户对象
     * @param {string} reason - 解除原因
     * @param {Object} options - 额外选项
     * @param {boolean} [options.isAppeal=false] - 是否是上诉通过导致的解除
     * @returns {Promise<{success: boolean, successfulServers: string[], failedServers: {id: string, name: string}[]}>}
     */
    static async revokePunishmentInGuilds(client, punishment, target, reason, options = {}) {
        const { isAppeal = false } = options;
        const successfulServers = [];
        const failedServers = [];
        const allGuilds = Array.from(client.guildManager.guilds.values());

        return await ErrorHandler.handleService(
            async () => {
                // 更新处罚状态
                await PunishmentModel.updateStatus(punishment.id, isAppeal ? 'appealed' : 'revoked', reason);
                logTime(`[处罚系统] 处罚 ${punishment.id} 状态已更新为 ${isAppeal ? '上诉通过' : '已撤销'}`);

                for (const guildData of allGuilds) {
                    if (!guildData?.id) continue;

                    const guild = await ErrorHandler.handleSilent(
                        () => client.guilds.fetch(guildData.id),
                        `获取服务器 ${guildData.id}`,
                        null
                    );

                    if (!guild) {
                        failedServers.push({
                            id: guildData.id,
                            name: guildData.name || guildData.id,
                        });
                        continue;
                    }

                    // 根据处罚类型执行不同的解除操作
                    switch (punishment.type) {
                        case 'mute':
                            const muteResult = await ErrorHandler.handleSilent(
                                async () => {
                                    const targetMember = await guild.members.fetch(target.id);
                                    if (!targetMember) return false;

                                    // 解除禁言
                                    await targetMember.timeout(null, reason);
                                    logTime(`[处罚系统] 已在服务器 ${guild.name} 解除用户 ${target.tag} 的禁言`);

                                    // 移除警告身份组
                                    if (guildData.roleApplication?.WarnedRoleId) {
                                        await ErrorHandler.handleSilent(
                                            () => targetMember.roles.remove(guildData.roleApplication?.WarnedRoleId, reason),
                                            `移除用户 ${target.tag} 在服务器 ${guild.name} 的警告身份组`
                                        );
                                    }
                                    return true;
                                },
                                `解除用户 ${target.tag} 在服务器 ${guild.name} 的禁言`
                            );
                            if (muteResult) {
                                successfulServers.push(guild.name);
                            } else {
                                failedServers.push({ id: guild.id, name: guild.name });
                            }
                            break;

                        case 'warning':
                            const warningResult = await ErrorHandler.handleSilent(
                                async () => {
                                    const targetMember = await guild.members.fetch(target.id);
                                    if (!targetMember) return false;

                                    // 移除警告身份组
                                    if (guildData.roleApplication?.WarnedRoleId) {
                                        await ErrorHandler.handleSilent(
                                            () => targetMember.roles.remove(guildData.roleApplication?.WarnedRoleId, reason),
                                            `移除用户 ${target.tag} 在服务器 ${guild.name} 的警告身份组`
                                        );
                                        logTime(`[处罚系统] 已在服务器 ${guild.name} 移除用户 ${target.tag} 的警告身份组`);
                                    }
                                    return true;
                                },
                                `移除用户 ${target.tag} 在服务器 ${guild.name} 的警告身份组`
                            );
                            if (warningResult) {
                                successfulServers.push(guild.name);
                            } else {
                                failedServers.push({ id: guild.id, name: guild.name });
                            }
                            break;

                        case 'ban':
                        case 'softban':
                            const banResult = await ErrorHandler.handleSilent(
                                async () => {
                                    // 先检查用户是否被ban
                                    const bans = await guild.bans.fetch();
                                    if (!bans.has(target.id)) {
                                        logTime(`[处罚系统] 用户 ${target.tag} 在服务器 ${guild.name} 未被封禁，跳过解除`, true);
                                        return false;
                                    }

                                    // 解除封禁
                                    await guild.bans.remove(target.id, reason);
                                    logTime(`[处罚系统] 已在服务器 ${guild.name} 解除用户 ${target.tag} 的${punishment.type === 'softban' ? '软封锁' : '封禁'}`);
                                    return true;
                                },
                                `解除用户 ${target.tag} 在服务器 ${guild.name} 的${punishment.type === 'softban' ? '软封锁' : '封禁'}`
                            );
                            if (banResult) {
                                successfulServers.push(guild.name);
                            } else {
                                failedServers.push({ id: guild.id, name: guild.name });
                            }
                            break;
                    }
                }

                // 记录执行结果
                if (failedServers.length > 0) {
                    logTime(`[处罚系统] 处罚解除失败的服务器: ${failedServers.map(s => s.name).join(', ')}`, true);
                }

                return { success: true, successfulServers, failedServers };
            },
            '解除处罚',
            { throwOnError: true }
        );
    }

    /**
     * 执行处罚操作
     * @param {Object} guild - Discord服务器对象
     * @param {Object} punishment - 处罚数据库记录
     * @param {boolean} [isSync=false] - 是否为同步执行（用户重新加入时）
     * @returns {Promise<boolean>} 执行是否成功
     */
    static async executePunishmentAction(guild, punishment, isSync = false) {
        if (!guild || !guild.members) {
            logTime(`无效的服务器对象: ${JSON.stringify(guild)}`, true);
            return false;
        }

        const reason = `处罚ID: ${punishment.id} - ${punishment.reason}`;
        const guildConfig = guild.client?.guildManager?.getGuildConfig?.(guild.id);

        switch (punishment.type) {
            case 'ban':
                // Ban 可以直接执行
                await guild.members.ban(punishment.userId, {
                    deleteMessageSeconds: punishment.keepMessages ? 0 : 7 * 24 * 60 * 60,
                    reason,
                });
                break;

            case 'softban':
                if (isSync) {
                    // 用户重新加入时，只处理警告身份组
                    const member = await ErrorHandler.handleSilent(
                        () => guild.members.fetch(punishment.userId),
                        `获取用户 ${punishment.userId} 在服务器 ${guild.name}`,
                        null
                    );

                    if (member && PunishmentService.isWarningStillValid(punishment) && guildConfig?.roleApplication?.WarnedRoleId) {
                        await ErrorHandler.handleSilent(
                            () => member.roles.add(guildConfig.roleApplication?.WarnedRoleId, reason),
                            `添加用户 ${member.user.tag} 在服务器 ${guild.name} 的警告身份组`
                        );
                        logTime(`[处罚系统] 已为用户 ${member.user.tag} 添加警告身份组 (处罚ID: ${punishment.id})`);
                    }
                    logTime(`[处罚系统] 软封锁同步执行：为用户处理警告身份组 (处罚ID: ${punishment.id})`);
                } else {
                    // 首次执行软封锁（封禁+解封）
                    await guild.members.ban(punishment.userId, {
                        deleteMessageSeconds: 7 * 24 * 60 * 60, // 删除7天消息
                        reason,
                    });
                    logTime(`[处罚系统] 已对用户 ${punishment.userId} 执行软封锁第一步：封禁并删除消息`);

                    // 立即解除封禁
                    await guild.bans.remove(punishment.userId, `软封锁解除 - ${reason}`);
                    logTime(`[处罚系统] 已对用户 ${punishment.userId} 执行软封锁第二步：立即解除封禁`);
                }
                break;

            case 'mute':
                // 计算剩余禁言时长
                const now = Date.now();
                const expiryTime = punishment.createdAt + punishment.duration;
                const remainingDuration = Math.max(0, expiryTime - now);

                // 如果已经过期，不执行禁言
                if (remainingDuration === 0) {
                    logTime(`[处罚系统] 禁言处罚 ${punishment.id} 已过期，跳过执行`);
                    return true;
                }

                // 尝试获取成员对象
                const member = await ErrorHandler.handleSilent(
                    () => guild.members.fetch(punishment.userId),
                    `获取用户 ${punishment.userId} 在服务器 ${guild.name}`,
                    null
                );

                if (!member) {
                    logTime(`[处罚系统] 用户 ${punishment.userId} 不在服务器 ${guild.name} 中，仅记录处罚`);
                    return true;
                }

                // 执行禁言
                await member.timeout(remainingDuration, reason);

                // 如果有警告，添加警告身份组
                if (PunishmentService.isWarningStillValid(punishment) && guildConfig?.roleApplication?.WarnedRoleId) {
                    await ErrorHandler.handleSilent(
                        () => member.roles.add(guildConfig.roleApplication?.WarnedRoleId, reason),
                        `添加用户 ${member.user.tag} 在服务器 ${guild.name} 的警告身份组`
                    );
                }
                break;

            case 'warning':
                const warningMember = await ErrorHandler.handleSilent(
                    () => guild.members.fetch(punishment.userId),
                    `获取用户 ${punishment.userId} 在服务器 ${guild.name}`,
                    null
                );

                if (!warningMember) {
                    logTime(`[处罚系统] 用户 ${punishment.userId} 不在服务器 ${guild.name} 中，仅记录处罚`);
                    return true;
                }

                // 添加警告身份组
                if (PunishmentService.isWarningStillValid(punishment) && guildConfig?.roleApplication?.WarnedRoleId) {
                    await ErrorHandler.handleSilent(
                        () => warningMember.roles.add(guildConfig.roleApplication?.WarnedRoleId, reason),
                        `添加用户 ${warningMember.user.tag} 在服务器 ${guild.name} 的警告身份组`
                    );
                    logTime(`[处罚系统] 已为用户 ${warningMember.user.tag} 添加警告身份组 (处罚ID: ${punishment.id})`);
                }
                break;

            default:
                logTime(`[处罚系统] 未知的处罚类型: ${punishment.type}`, true);
                return false;
        }

        return true;
    }
}

export default PunishmentService;
