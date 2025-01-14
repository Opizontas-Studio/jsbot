/**
 * 性能统计函数
 * @returns {Function} 返回一个计算经过时间的函数
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
 * 检查权限
 * @param {Member} member - 成员对象
 * @param {Array<string>} allowedRoleIds - 允许的角色ID数组
 * @returns {boolean} 是否具有权限
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

module.exports = {
    measureTime,
    delay,
    logTime,
    checkPermission,
    handlePermissionResult
}; 