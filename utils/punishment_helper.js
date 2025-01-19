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
 * 生成处罚通知嵌入消息
 * @param {Object} punishment - 处罚记录
 * @param {Object} executor - 执行者用户对象
 * @param {Object} target - 目标用户对象
 * @returns {Object} Discord嵌入消息对象
 */
export const createPunishmentEmbed = (punishment, executor, target) => {
    const typeText = {
        ban: '永封',
        mute: '禁言',
        warn: '警告'
    };

    return {
        color: 0xFF0000,
        title: `用户已被${typeText[punishment.type]}`,
        fields: [
            {
                name: '处罚对象',
                value: `${target.tag} (${target.id})`,
                inline: true
            },
            {
                name: '执行者',
                value: `${executor.tag} (${executor.id})`,
                inline: true
            },
            {
                name: '处罚时长',
                value: formatPunishmentDuration(punishment.duration),
                inline: true
            },
            {
                name: '原因',
                value: punishment.reason || '未提供原因',
                inline: false
            }
        ],
        timestamp: new Date(),
        footer: {
            text: `处罚ID: ${punishment.id}`
        }
    };
};

/**
 * 生成上诉控件
 * @param {Object} punishment - 处罚记录
 * @returns {Object} Discord按钮组件
 */
export const createAppealComponents = (punishment) => {
    return {
        type: 1,
        components: [
            {
                type: 2,
                style: 1,
                label: '提交上诉',
                custom_id: `appeal_${punishment.id}`,
                disabled: punishment.status !== 'active'
            }
        ]
    };
}; 