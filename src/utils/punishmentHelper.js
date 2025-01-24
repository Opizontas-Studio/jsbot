import { PunishmentModel } from '../db/models/punishmentModel.js';
import { logTime } from './logger.js';

/**
 * 计算处罚到期时间
 * @param {string} duration - 处罚时长字符串 (如 "3d4h5m")
 * @returns {number} 处罚时长(毫秒)，永封返回-1
 */
export const calculatePunishmentDuration = (duration) => {
    if (duration === 'permanent') return -1;

    const regex = /(\d+)([dhm])/g;
    let total = 0;
    let match;

    while ((match = regex.exec(duration)) !== null) {
	    const [, value, unit] = match;
	    switch (unit) {
	        case 'd': total += parseInt(value) * 24 * 60 * 60 * 1000; break;
	        case 'h': total += parseInt(value) * 60 * 60 * 1000; break;
	        case 'm': total += parseInt(value) * 60 * 1000; break;
	    }
    }

    return total || -1;
};

/**
 * 格式化处罚时长显示
 * @param {number} duration - 处罚时长(毫秒)
 * @returns {string} 格式化的时长字符串
 */
export const formatPunishmentDuration = (duration) => {
    if (duration === -1) return '永久';

    const days = Math.floor(duration / (24 * 60 * 60 * 1000));
    const hours = Math.floor((duration % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((duration % (60 * 60 * 1000)) / (60 * 1000));

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);

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

	    const member = await guild.members.fetch(punishment.userId).catch(error => {
	        logTime(`获取成员失败: ${error.message}`, true);
	        return null;
	    });
	    if (!member) {
	        logTime(`无法在服务器 ${guild.name} 找到目标用户 ${punishment.userId}`, true);
	        return false;
	    }

	    const reason = `处罚ID: ${punishment.id} - ${punishment.reason}`;
	    const guildConfig = guild.client.guildManager.getGuildConfig(guild.id);

	    switch (punishment.type) {
	        case 'ban':
	            await guild.members.ban(member.id, {
	                deleteMessageSeconds: punishment.keepMessages ? 0 : 7 * 24 * 60 * 60,
	                reason,
	            });
	            break;

	        case 'mute':
	            // 执行禁言
	            await member.timeout(punishment.duration, reason);

	            // 如果有警告，添加警告身份组
	            if (punishment.warningDuration && guildConfig?.WarnedRoleId) {
	                await member.roles.add(guildConfig.WarnedRoleId, reason)
	                    .catch(error => logTime(`添加警告身份组失败: ${error.message}`, true));
	            }
	            break;

	        default:
	            logTime(`未知的处罚类型: ${punishment.type}`, true);
	            return false;
	    }

	    return true;
    } catch (error) {
	    logTime(`在服务器 ${guild.name} 执行处罚失败: ${error.message}`, true);
	    if (error.stack) {
	        logTime(`错误堆栈: ${error.stack}`, true);
	    }
	    return false;
    }
};

/**
 * 发送管理日志通知
 * @param {Object} channel - Discord频道对象
 * @param {Object} punishment - 处罚数据库记录
 * @param {Object} executor - 执行者用户对象
 * @param {Object} target - 目标用户对象
 * @returns {Promise<boolean>} 发送是否成功
 */
export const sendModLogNotification = async (channel, punishment, executor, target) => {
    try {
	    const embed = {
	        color: 0xFF0000,
	        title: `用户已被${getPunishmentTypeText(punishment.type)}`,
	        fields: [
	            {
	                name: '处罚对象',
	                value: `<@${target.id}>`,
	                inline: true,
	            },
	            {
	                name: '执行管理员',
	                value: `<@${executor.id}>`,
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

	    await channel.send({ embeds: [embed] });
	    return true;
    } catch (error) {
	    logTime(`发送管理日志通知失败: ${error.message}`, true);
	    return false;
    }
};

/**
 * 发送上诉通知
 * @param {Object} channel - Discord频道对象
 * @param {Object} target - 目标用户对象
 * @param {Object} punishment - 处罚数据库记录
 * @returns {Promise<boolean>} 发送是否成功
 */
export const sendAppealNotification = async (channel, target, punishment) => {
    try {
        const executor = await channel.client.users.fetch(punishment.executorId);

        // 检查处罚时长是否小于24小时
        const isShortPunishment = punishment.duration > 0 && punishment.duration < 24 * 60 * 60 * 1000;

        // 检查处罚是否已过期
        const now = Date.now();
        const isPunishmentExpired = punishment.duration > 0 && (punishment.createdAt + punishment.duration <= now);

        // 频道通知的 embed
        const channelEmbed = {
            color: 0xFF0000,
            title: `${getPunishmentTypeText(punishment.type)}通知`,
            description: [
                `处罚对象：<@${target.id}>`,
                '',
                '**处罚详情**',
                `• 处罚期限：${formatPunishmentDuration(punishment.duration)}`,
                punishment.warningDuration ? `• 附加警告：${formatPunishmentDuration(punishment.warningDuration)}` : null,
                `• 处罚理由：${punishment.reason || '未提供原因'}`,
                '',
                punishment.type === 'ban' ? '⚠️ 永封处罚不支持上诉申请。' :
                    isShortPunishment ? '⚠️ 由于处罚时长小于24小时，不予受理上诉申请。' :
                        isPunishmentExpired ? '⚠️ 处罚已到期，无需上诉。' :
                            '如需上诉，请查看私信消息。',
            ].filter(Boolean).join('\n'),
            footer: {
                text: `由管理员 ${executor.tag} 执行`,
            },
            timestamp: new Date(),
        };

        // 发送到频道（不包含上诉按钮）
        await channel.send({ embeds: [channelEmbed] });

        // 如果是永封处罚，直接返回
        if (punishment.type === 'ban') {
            return true;
        }

        // 私信通知的 embed
        const dmEmbed = {
            color: 0xFF0000,
            title: `${getPunishmentTypeText(punishment.type)}通知`,
            description: [
                `处罚对象：<@${target.id}>`,
                '',
                '**处罚详情**',
                `• 处罚期限：${formatPunishmentDuration(punishment.duration)}`,
                punishment.warningDuration ? `• 附加警告：${formatPunishmentDuration(punishment.warningDuration)}` : null,
                `• 处罚理由：${punishment.reason || '未提供原因'}`,
                '',
                isShortPunishment ? '⚠️ 由于处罚时长小于24小时，不予受理上诉申请。' :
                    isPunishmentExpired ? '⚠️ 处罚已到期，无需上诉。' :
                        [
                            '**上诉说明**',
                            '- 点击下方按钮开始上诉流程，周期3天',
                            '- 请在控件中提交详细的上诉文章',
                            '- 需至少10位议员匿名赞同才能进入辩诉流程',
                            '- 请注意查看私信消息，了解上诉进展',
                        ].join('\n'),
            ].filter(Boolean).join('\n'),
            footer: {
                text: `由管理员 ${executor.tag} 执行`,
            },
            timestamp: new Date(),
        };

        // 只有在处罚未过期且时长大于24小时时才添加上诉按钮
        const appealComponents = !isShortPunishment && !isPunishmentExpired ? [{
            type: 1,
            components: [{
                type: 2,
                style: 1,
                label: '提交上诉',
                custom_id: `appeal_${punishment.id}`,
                emoji: '📝',
                disabled: false,
            }],
        }] : [];

        // 尝试发送私信（包含上诉按钮和详细说明）
        try {
            await target.send({
                embeds: [dmEmbed],
                components: appealComponents,
            });
        } catch (error) {
            logTime(`无法发送私信到用户 ${target.tag}: ${error.message}`);
        }

        return true;
    } catch (error) {
        logTime(`发送上诉通知失败: ${error.message}`, true);
        return false;
    }
};

/**
 * 获取处罚类型的中文描述
 */
const getPunishmentTypeText = (type) => ({
    ban: '永封',
    mute: '禁言',
    warn: '警告',
})[type] || type;

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
        await PunishmentModel.updateStatus(
            punishment.id,
            isAppeal ? 'appealed' : 'revoked',
            reason,
        );
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
                        await targetMember.timeout(null, reason)
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
                        if (guildData.WarnedRoleId) {
                            await targetMember.roles.remove(guildData.WarnedRoleId, reason)
                                .then(() => logTime(`已在服务器 ${guild.name} 移除用户 ${target.tag} 的警告身份组`))
                                .catch(error => logTime(`在服务器 ${guild.name} 移除警告身份组失败: ${error.message}`, true));
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
                        await guild.bans.remove(target.id, reason)
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