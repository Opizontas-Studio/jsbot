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
