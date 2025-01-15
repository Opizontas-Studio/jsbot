/**
 * 计算执行时间的工具函数
 * @returns {Function} 返回一个函数，调用时返回从开始到现在的秒数（保留两位小数）
 */
const measureTime = () => {
    const start = process.hrtime();
    return () => {
        const [seconds, nanoseconds] = process.hrtime(start);
        return (seconds + nanoseconds / 1e9).toFixed(2);
    };
};

/**
 * 延迟函数
 * @param {number} ms - 延迟时间（毫秒）
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 记录时间日志
 * @param {string} message - 日志消息
 * @param {boolean} [error=false] - 是否为错误日志
 */
const logTime = (message, error = false) => {
    const prefix = error ? '❌ ' : '';
    console.log(`[${new Date().toLocaleString()}] ${prefix}${message}`);
};

/**
 * 检查用户是否具有执行命令的权限
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {string[]} allowedRoleIds - 允许执行命令的角色ID数组
 * @returns {boolean} 如果用户拥有允许的角色则返回true
 */
const checkPermission = (member, allowedRoleIds) => {
    return member.roles.cache.some(role => allowedRoleIds.includes(role.id));
};

/**
 * 处理权限检查结果
 * @param {Interaction} interaction - Discord交互对象
 * @param {boolean} hasPermission - 权限检查结果
 * @returns {Promise<boolean>} 如果没有权限返回false
 */
const handlePermissionResult = async (interaction, hasPermission) => {
    if (!hasPermission) {
        await interaction.reply({
            content: '你没有权限使用此命令。需要具有指定的身份组权限。',
            ephemeral: true
        });
        return false;
    }
    return true;
};

/**
 * 检查用户是否具有特定频道的权限
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {Channel} channel - Discord频道对象
 * @param {string[]} allowedRoleIds - 允许执行命令的角色ID数组
 * @returns {boolean} 如果用户拥有权限则返回true
 */
const checkChannelPermission = (member, channel, allowedRoleIds) => {
    // 检查用户是否有全局身份组权限
    const hasGlobalPermission = member.roles.cache.some(role => allowedRoleIds.includes(role.id));
    if (hasGlobalPermission) return true;

    // 获取用户在该频道的权限
    const channelPermissions = channel.permissionsFor(member);
    
    // 如果是论坛帖子，检查父频道的权限
    if (channel.isThread()) {
        const parentPermissions = channel.parent.permissionsFor(member);
        return parentPermissions.has('ManageMessages');
    }
    
    // 检查频道的权限
    return channelPermissions.has('ManageMessages');
};

module.exports = {
    measureTime,
    delay,
    logTime,
    checkPermission,
    handlePermissionResult,
    checkChannelPermission
}; 