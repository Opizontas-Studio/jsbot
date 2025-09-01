import { PunishmentModel } from '../db/models/punishmentModel.js';
import { logTime } from './logger.js';

/**
 * 计算处罚到期时间
 * @param {string} duration - 处罚时长字符串 (如 "3d4h5m")
 * @returns {number} 处罚时长(毫秒)，永封返回-1
 */
export const calculatePunishmentDuration = duration => {
    if (duration === 'permanent') {
        return -1;
    }

    const regex = /(\d+)([dhm])/g;
    let total = 0;
    let match;

    while ((match = regex.exec(duration)) !== null) {
        const [, value, unit] = match;
        switch (unit) {
            case 'd':
                total += parseInt(value) * 24 * 60 * 60 * 1000;
                break;
            case 'h':
                total += parseInt(value) * 60 * 60 * 1000;
                break;
            case 'm':
                total += parseInt(value) * 60 * 1000;
                break;
        }
    }

    return total || -1;
};

/**
 * 格式化处罚时长显示
 * @param {number} duration - 处罚时长(毫秒)
 * @returns {string} 格式化的时长字符串
 */
export const formatPunishmentDuration = duration => {
    if (duration === -1) {
        return '永久';
    }

    const days = Math.floor(duration / (24 * 60 * 60 * 1000));
    const hours = Math.floor((duration % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((duration % (60 * 60 * 1000)) / (60 * 1000));

    const parts = [];
    if (days > 0) {
        parts.push(`${days}天`);
    }
    if (hours > 0) {
        parts.push(`${hours}小时`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}分钟`);
    }

    return parts.join('');
};

/**
 * 执行处罚操作
 * @param {Object} guild - Discord服务器对象
 * @param {Object} punishment - 处罚数据库记录
 * @returns {Promise<boolean>} 执行是否成功
 */
export const executePunishmentAction = async (guild, punishment) => {
    try {
        if (!guild || !guild.members) {
            logTime(`无效的服务器对象: ${JSON.stringify(guild)}`, true);
            return false;
        }

        const reason = `处罚ID: ${punishment.id} - ${punishment.reason}`;
        const guildConfig = guild.client.guildManager.getGuildConfig(guild.id);

        switch (punishment.type) {
            case 'ban':
                // Ban 可以直接执行
                await guild.members.ban(punishment.userId, {
                    deleteMessageSeconds: punishment.keepMessages ? 0 : 7 * 24 * 60 * 60,
                    reason,
                });
                break;

            case 'mute':
                try {
                    // 计算剩余禁言时长
                    const now = Date.now();
                    const expiryTime = punishment.createdAt + punishment.duration;
                    const remainingDuration = Math.max(0, expiryTime - now);

                    // 如果已经过期，不执行禁言
                    if (remainingDuration === 0) {
                        logTime(`禁言处罚 ${punishment.id} 已过期，跳过执行`);
                        return true;
                    }

                    // 尝试获取成员对象
                    const member = await guild.members.fetch(punishment.userId);

                    // 执行禁言
                    await member.timeout(remainingDuration, reason);

                    // 如果有警告，添加警告身份组
                    if (punishment.warningDuration && guildConfig?.roleApplication?.WarnedRoleId) {
                        // 检查警告是否仍然有效
                        const warningExpiryTime = punishment.createdAt + punishment.warningDuration;
                        if (warningExpiryTime > now) {
                            await member.roles
                                .add(guildConfig.roleApplication?.WarnedRoleId, reason)
                                .catch(error => logTime(`添加警告身份组失败: ${error.message}`, true));
                        }
                    }
                } catch (error) {
                    if (error.code === 10007) {
                        // UNKNOWN_MEMBER
                        logTime(`用户 ${punishment.userId} 不在服务器 ${guild.name} 中，仅记录处罚`);
                        // 返回 true 因为这是预期的情况
                        return true;
                    }
                    throw error;
                }
                break;

            default:
                logTime(`未知的处罚类型: ${punishment.type}`, true);
                return false;
        }

        return true;
    } catch (error) {
        logTime(`在服务器 ${guild.name} 执行处罚失败: ${error.message}`, true);
        return false;
    }
};

/**
 * 发送管理日志通知
 * @param {Object} channel - Discord频道对象
 * @param {Object} punishment - 处罚数据库记录
 * @param {Object} executor - 执行者用户对象
 * @param {Object} target - 目标用户对象
 * @returns {Promise<Object>} 发送结果，包含消息ID和服务器ID
 */
export const sendModLogNotification = async (channel, punishment, executor, target) => {
    try {
        // 获取目标用户的头像URL
        const targetAvatarURL =
            target.displayAvatarURL({
                dynamic: true,
                size: 64,
            }) || target.defaultAvatarURL;

        const embed = {
            color: 0xff0000,
            title: `${target.username} 已被${getPunishmentTypeText(punishment.type)}`,
            thumbnail: {
                url: targetAvatarURL,
            },
            fields: [
                {
                    name: '处罚对象',
                    value: `<@${target.id}>`,
                    inline: true,
                },
                {
                    name: '处罚期限',
                    value: formatPunishmentDuration(punishment.duration),
                    inline: true,
                },
                {
                    name: '处罚理由',
                    value: punishment.reason || '未提供原因',
                },
            ],
            timestamp: new Date(),
            footer: { text: `处罚ID: ${punishment.id}` },
        };

        // 如果有警告，添加警告信息
        if (punishment.warningDuration) {
            embed.fields.push({
                name: '警告时长',
                value: formatPunishmentDuration(punishment.warningDuration),
                inline: true,
            });
        }

        // 如果有投票信息，添加链接
        if (punishment.voteInfo) {
            const voteLink = `https://discord.com/channels/${punishment.voteInfo.guildId}/${punishment.voteInfo.channelId}/${punishment.voteInfo.messageId}`;
            embed.fields.push({
                name: '议会投票',
                value: `[点击查看投票结果](${voteLink})`,
                inline: true,
            });
        }

        const message = await channel.send({ embeds: [embed] });
        return {
            success: true,
            messageId: message.id,
            guildId: channel.guild.id,
        };
    } catch (error) {
        logTime(`发送管理日志通知失败: ${error.message}`, true);
        return {
            success: false,
        };
    }
};

/**
 * 发送频道通知
 * @param {Object} channel - Discord频道对象
 * @param {Object} target - 目标用户对象
 * @param {Object} punishment - 处罚数据库记录
 * @returns {Promise<boolean>} 发送是否成功
 */
export const sendChannelNotification = async (channel, target, punishment) => {
    try {
        const executor = await channel.client.users.fetch(punishment.executorId);

        // 获取目标用户的头像URL
        const targetAvatarURL =
            target.displayAvatarURL({
                dynamic: true,
                size: 64,
            }) || target.defaultAvatarURL;
        // 频道通知的 embed
        const channelEmbed = {
            color: 0xff0000,
            title: `${getPunishmentTypeText(punishment.type)}处罚已执行`,
            thumbnail: {
                url: targetAvatarURL,
            },
            fields: [
                {
                    name: '处罚对象',
                    value: `<@${target.id}>`,
                    inline: true,
                },
                {
                    name: '处罚期限',
                    value: punishment.duration > 0 ? formatPunishmentDuration(punishment.duration) : '永久',
                    inline: true,
                },
                {
                    name: '处罚理由',
                    value: punishment.reason || '未提供原因',
                },
            ],
            footer: {
                text: `如有异议，请联系服务器主或在任管理员。`,
            },
            timestamp: new Date(),
        };

        // 如果有警告，添加警告信息
        if (punishment.warningDuration) {
            channelEmbed.fields.push({
                name: '附加警告',
                value: formatPunishmentDuration(punishment.warningDuration),
                inline: true,
            });
        }
        // 发送到频道
        await channel.send({ embeds: [channelEmbed] });
        return true;
    } catch (error) {
        logTime(`发送频道通知失败: ${error.message}`, true);
        return false;
    }
};

/**
 * 发送禁言通知
 * @param {Object} channel - Discord频道对象
 * @param {Object} target - 目标用户对象
 * @param {Object} punishment - 处罚数据库记录
 * @returns {Promise<boolean>} 发送是否成功
 */
export const sendMuteNotification = async (channel, target, punishment) => {
    try {
        // 私信通知的 embed
        const dmEmbed = {
            color: 0xff0000,
            title: '⚠️ **禁言通知**',
            description: [
                '您已在旅程ΟΡΙΖΟΝΤΑΣ被禁言：',
                `• 禁言期限：${formatPunishmentDuration(punishment.duration)}`,
                punishment.warningDuration
                    ? `• 附加警告：${formatPunishmentDuration(punishment.warningDuration)}`
                    : null,
                `• 禁言理由：${punishment.reason || '未提供原因'}`,
            ]
                .filter(Boolean)
                .join('\n'),
            footer: {
                text: `如有异议，请联系服务器主或在任管理员。`,
            },
            timestamp: new Date(),
        };

        // 发送私信（包含上诉按钮和详细说明）
        await target.send({
            embeds: [dmEmbed],
        });

        return true;
    } catch (error) {
        logTime(`发送处罚通知失败: ${error.message}`, true);
        return false;
    }
};

/**
 * 发送永封通知
 * @param {Object} target - 目标用户对象
 * @param {Object} punishment - 处罚数据库记录
 * @returns {Promise<boolean>} 发送是否成功
 */
export const sendBanNotification = async (target, punishment) => {
    try {
        // 私信通知的 embed
        const dmEmbed = {
            color: 0xff0000,
            title: '⚠️ **永封通知**',
            description: [
                '您已在旅程ΟΡΙΖΟΝΤΑΣ被永久封禁：',
                `• 封禁理由：${punishment.reason || '未提供原因'}`,
                `• 执行时间：<t:${Math.floor(Date.now() / 1000)}:F>`,
            ].join('\n'),
            footer: {
                text: `如有异议，请联系服务器主或在任管理员。`,
            },
            timestamp: new Date(),
        };

        // 发送私信
        await target.send({
            embeds: [dmEmbed],
        });

        return true;
    } catch (error) {
        logTime(`发送永封通知失败: ${error.message}`, true);
        return false;
    }
};

/**
 * 获取处罚类型的中文描述
 */
const getPunishmentTypeText = type =>
    ({
        ban: '永封',
        mute: '禁言',
        warn: '警告',
    }[type] || type);

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
export const revokePunishmentInGuilds = async (client, punishment, target, reason, options = {}) => {
    const { isAppeal = false } = options;
    const successfulServers = [];
    const failedServers = [];
    const allGuilds = Array.from(client.guildManager.guilds.values());

    try {
        // 更新处罚状态
        await PunishmentModel.updateStatus(punishment.id, isAppeal ? 'appealed' : 'revoked', reason);
        logTime(`处罚 ${punishment.id} 状态已更新为 ${isAppeal ? '上诉通过' : '已撤销'}`);

        for (const guildData of allGuilds) {
            try {
                if (!guildData || !guildData.id) {
                    logTime('跳过无效的服务器配置', true);
                    continue;
                }

                const guild = await client.guilds.fetch(guildData.id).catch(error => {
                    logTime(`获取服务器失败: ${error.message}`, true);
                    return null;
                });

                if (!guild) {
                    logTime(`无法获取服务器 ${guildData.id}`, true);
                    failedServers.push({
                        id: guildData.id,
                        name: guildData.name || guildData.id,
                    });
                    continue;
                }

                // 根据处罚类型执行不同的解除操作
                let targetMember;
                let bans;

                switch (punishment.type) {
                    case 'mute':
                        targetMember = await guild.members.fetch(target.id).catch(() => null);
                        if (!targetMember) {
                            logTime(`无法在服务器 ${guild.name} 找到目标用户，跳过`, true);
                            continue;
                        }

                        // 解除禁言
                        await targetMember
                            .timeout(null, reason)
                            .then(() => {
                                logTime(`已在服务器 ${guild.name} 解除用户 ${target.tag} 的禁言`);
                                successfulServers.push(guild.name);
                            })
                            .catch(error => {
                                logTime(`在服务器 ${guild.name} 解除禁言失败: ${error.message}`, true);
                                failedServers.push({
                                    id: guild.id,
                                    name: guild.name,
                                });
                            });

                        // 移除警告身份组
                        if (guildData.roleApplication?.WarnedRoleId) {
                            await targetMember.roles
                                .remove(guildData.roleApplication?.WarnedRoleId, reason)
                                .then(() => logTime(`已在服务器 ${guild.name} 移除用户 ${target.tag} 的警告身份组`))
                                .catch(error =>
                                    logTime(`在服务器 ${guild.name} 移除警告身份组失败: ${error.message}`, true),
                                );
                        }
                        break;

                    case 'ban':
                        // 先检查用户是否被ban
                        bans = await guild.bans.fetch().catch(error => {
                            logTime(`在服务器 ${guild.name} 获取封禁列表失败: ${error.message}`, true);
                            return null;
                        });

                        if (!bans) {
                            logTime(`无法获取服务器 ${guild.name} 的封禁列表`, true);
                            failedServers.push({
                                id: guild.id,
                                name: guild.name,
                            });
                            continue;
                        }

                        // 如果用户不在ban列表中，记录并跳过
                        if (!bans.has(target.id)) {
                            logTime(`用户 ${target.tag} 在服务器 ${guild.name} 未被封禁，跳过解除`, true);
                            continue;
                        }

                        // 解除封禁
                        await guild.bans
                            .remove(target.id, reason)
                            .then(() => {
                                logTime(`已在服务器 ${guild.name} 解除用户 ${target.tag} 的封禁`);
                                successfulServers.push(guild.name);
                            })
                            .catch(error => {
                                logTime(`在服务器 ${guild.name} 解除封禁失败: ${error.message}`, true);
                                failedServers.push({
                                    id: guild.id,
                                    name: guild.name,
                                });
                            });
                        break;
                }
            } catch (error) {
                logTime(`在服务器 ${guildData.id} 处理处罚解除失败: ${error.message}`, true);
                failedServers.push({
                    id: guildData.id,
                    name: guildData.name || guildData.id,
                });
            }
        }

        // 记录执行结果
        if (successfulServers.length > 0) {
            logTime(`处罚解除成功的服务器: ${successfulServers.join(', ')}`);
        }
        if (failedServers.length > 0) {
            logTime(`处罚解除失败的服务器: ${failedServers.map(s => s.name).join(', ')}`, true);
        }

        return { success: true, successfulServers, failedServers };
    } catch (error) {
        logTime(`处罚解除失败: ${error.message}`, true);
        return { success: false, successfulServers, failedServers };
    }
};


