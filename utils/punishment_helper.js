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

        switch (punishment.type) {
            case 'ban':
                await guild.members.ban(member.id, {
                    deleteMessageSeconds: punishment.keepMessages ? 0 : 7 * 24 * 60 * 60,
                    reason
                });
                break;

            case 'mute':
                // 执行禁言
                await member.timeout(punishment.duration, reason);

                // 如果有警告，添加警告身份组
                const guildConfig = guild.client.guildManager.getGuildConfig(guild.id);
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
                    inline: true
                },
                {
                    name: '执行管理员',
                    value: `<@${executor.id}>`,
                    inline: true
                },
                {
                    name: '处罚期限',
                    value: formatPunishmentDuration(punishment.duration),
                    inline: true
                },
                {
                    name: '处罚理由',
                    value: punishment.reason || '未提供原因'
                }
            ],
            timestamp: new Date(),
            footer: { text: `处罚ID: ${punishment.id}` }
        };

        // 如果有警告，添加警告信息
        if (punishment.warningDuration) {
            embed.fields.push({
                name: '警告时长',
                value: formatPunishmentDuration(punishment.warningDuration),
                inline: true
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
        const embed = {
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
                '**上诉说明**',
                '- 点击下方按钮开始上诉流程，周期3天',
                '- 请在控件中提交详细的上诉文章',
                '- 需至少10位议员匿名赞同才能进入辩诉流程',
                '- 请注意查看私信消息，了解上诉进展'
            ].filter(Boolean).join('\n'),
            footer: { 
                text: `由管理员 ${executor.tag} 执行`,
            },
            timestamp: new Date()
        };

        const components = [{
            type: 1,
            components: [{
                type: 2,
                style: 1,
                label: '提交上诉',
                custom_id: `appeal_${punishment.id}`,
                emoji: '📝',
                disabled: false
            }]
        }];

        // 发送到频道
        await channel.send({ embeds: [embed], components });

        // 尝试发送私信
        try {
            await target.send({ embeds: [embed], components });
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
    warn: '警告'
})[type] || type; 