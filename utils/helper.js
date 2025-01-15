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
            flags: ['Ephemeral']
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

/**
 * 锁定并归档帖子
 * @param {ThreadChannel} thread - Discord帖子对象
 * @param {User} executor - 执行操作的用户
 * @param {string} reason - 操作原因
 * @param {Object} guildConfig - 服务器配置
 * @returns {Promise<void>}
 */
const lockAndArchiveThread = async (thread, executor, reason, guildConfig) => {
    // 发送通知
    await sendThreadNotification(thread, {
        title: '帖子已被锁定并归档',
        executorId: executor.id,
        reason: reason
    });

    // 发送操作日志
    await sendModerationLog(thread.client, guildConfig.moderationThreadId, {
        title: '帖子已被锁定并归档',
        executorId: executor.id,
        threadName: thread.name,
        threadUrl: thread.url,
        reason: reason
    });

    // 3. 执行锁定和归档操作
    await thread.setLocked(true, reason);
    await thread.setArchived(true, reason);
    
    logTime(`用户 ${executor.tag} 锁定并归档了帖子 ${thread.name}`);
};

/**
 * 发送操作日志到管理频道
 * @param {Client} client - Discord客户端
 * @param {string} moderationChannelId - 管理频道ID
 * @param {Object} logData - 日志数据
 * @param {string} logData.title - 日志标题
 * @param {string} logData.executorId - 执行者ID
 * @param {string} logData.threadName - 帖子名称
 * @param {string} logData.threadUrl - 帖子链接
 * @param {string} logData.reason - 操作原因
 */
async function sendModerationLog(client, moderationChannelId, logData) {
    const moderationChannel = await client.channels.fetch(moderationChannelId);
    await moderationChannel.send({
        embeds: [{
            color: 0x0099ff,
            title: logData.title,
            fields: [
                {
                    name: '操作人',
                    value: `<@${logData.executorId}>`,
                    inline: true
                },
                {
                    name: '主题',
                    value: `[${logData.threadName}](${logData.threadUrl})`,
                    inline: true
                },
                {
                    name: '原因',
                    value: logData.reason,
                    inline: false
                }
            ],
            timestamp: new Date(),
            footer: {
                text: '论坛管理系统'
            }
        }]
    });
}

/**
 * 发送通知到帖子中
 * @param {ThreadChannel} thread - Discord帖子对象
 * @param {Object} notifyData - 通知数据
 * @param {string} notifyData.title - 通知标题
 * @param {string} notifyData.executorId - 执行者ID
 * @param {string} notifyData.reason - 操作原因
 */
async function sendThreadNotification(thread, notifyData) {
    await thread.send({
        embeds: [{
            color: 0xffcc00,
            title: notifyData.title,
            fields: [
                {
                    name: '操作人',
                    value: `<@${notifyData.executorId}>`,
                    inline: true
                },
                {
                    name: '原因',
                    value: notifyData.reason,
                    inline: true
                }
            ],
            timestamp: new Date()
        }]
    });
}

/**
 * 生成进度报告
 * @param {number} current - 当前进度
 * @param {number} total - 总数
 * @param {string} prefix - 前缀文本
 * @returns {string} 格式化的进度信息
 */
function generateProgressReport(current, total, prefix = '') {
    const progress = (current / total * 100).toFixed(1);
    return `${prefix}${current}/${total} (${progress}%)`;
}

/**
 * 处理分批进度报告
 * @param {number} current - 当前进度
 * @param {number} total - 总数
 * @param {number[]} intervals - 进度间隔点数组
 * @param {number} lastProgressIndex - 上次报告的间隔索引
 * @param {Function} callback - 进度回调函数
 * @returns {number} 新的进度索引
 */
function handleBatchProgress(current, total, intervals, lastProgressIndex, callback) {
    const currentProgress = (current / total * 100);
    const progressIndex = intervals.findIndex(interval => 
        currentProgress >= interval && interval > (lastProgressIndex >= 0 ? intervals[lastProgressIndex] : 0)
    );

    if (progressIndex !== -1 && progressIndex > lastProgressIndex) {
        callback(current, total);
        return progressIndex;
    }
    return lastProgressIndex;
}

/**
 * 统一处理命令错误响应
 * @param {Interaction} interaction - Discord交互对象
 * @param {Error} error - 错误对象
 * @param {string} commandName - 命令名称
 */
async function handleCommandError(interaction, error, commandName) {
    logTime(`${commandName}执行出错: ${error}`, true);
    
    try {
        if (interaction.deferred) {
            await interaction.editReply({
                content: `❌ ${error.message}`,
                flags: ['Ephemeral']
            });
        } else {
            await interaction.reply({
                content: `❌ ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    } catch (replyError) {
        logTime(`发送错误响应失败: ${replyError}`, true);
    }
}

/**
 * 发送清理报告到管理频道
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} guildConfig - 服务器配置
 * @param {Object} result - 清理结果
 */
async function sendCleanupReport(interaction, guildConfig, result) {
    const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
    await moderationChannel.send({
        embeds: [{
            color: 0x0099ff,
            title: '子区人数重整报告',
            fields: [
                {
                    name: result.name,
                    value: [
                        `[跳转到子区](${result.url})`,
                        `原始人数: ${result.originalCount}`,
                        `移除人数: ${result.removedCount}`,
                        `当前人数: ${result.originalCount - result.removedCount}`,
                        result.lowActivityCount > 0 ? 
                            `(包含 ${result.lowActivityCount} 个低活跃度成员)` : 
                            ''
                    ].filter(Boolean).join('\n'),
                    inline: false
                }
            ],
            timestamp: new Date(),
            footer: {
                text: '论坛管理系统'
            }
        }]
    });
}

module.exports = {
    measureTime,
    delay,
    logTime,
    checkPermission,
    handlePermissionResult,
    checkChannelPermission,
    lockAndArchiveThread,
    sendModerationLog,
    sendThreadNotification,
    generateProgressReport,
    handleBatchProgress,
    handleCommandError,
    sendCleanupReport,
}; 