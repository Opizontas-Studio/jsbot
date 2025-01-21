import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logTime } from './logger.js';
import { DiscordAPIError } from '@discordjs/rest';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * 计算执行时间的工具函数
 * @returns {Function} 返回一个函数，调用时返回从开始到现在的秒数（保留两位小数）
 */
export const measureTime = () => {
    const start = process.hrtime();
    return () => {
        const [seconds, nanoseconds] = process.hrtime(start);
        return (seconds + nanoseconds / 1e9).toFixed(2);
    };
};

/**
 * 处理Discord API错误
 * @param {Error} error - 错误对象
 * @returns {string} 格式化的错误信息
 */
export const handleDiscordError = (error) => {
    if (error instanceof DiscordAPIError) {
        const errorMessages = {
            [RESTJSONErrorCodes.UnknownChannel]: '频道不存在或无法访问',
            [RESTJSONErrorCodes.MissingAccess]: '缺少访问权限',
            [RESTJSONErrorCodes.UnknownMessage]: '消息不存在或已被删除',
            [RESTJSONErrorCodes.MissingPermissions]: '缺少所需权限',
            [RESTJSONErrorCodes.InvalidThreadChannel]: '无效的主题频道',
            [RESTJSONErrorCodes.CannotSendMessagesToThisUser]: '无法向该用户发送消息',
            [RESTJSONErrorCodes.ReactionBlocked]: '表情反应被阻止',
            [RESTJSONErrorCodes.MaximumActiveThreads]: '已达到最大活跃子区数量',
            [RESTJSONErrorCodes.MaximumThreadParticipants]: '子区成员已达上限',
            [RESTJSONErrorCodes.ThreadArchived]: '子区已归档',
            [RESTJSONErrorCodes.ThreadLocked]: '子区已锁定',
            [RESTJSONErrorCodes.MaximumThreadMembers]: '子区成员数量已达到上限',
            [RESTJSONErrorCodes.NotThreadMember]: '不是子区成员',
            [RESTJSONErrorCodes.InteractionTimeout]: '交互已超时',
            [RESTJSONErrorCodes.MaximumPendingThreads]: '待处理子区数量已达上限',
            [RESTJSONErrorCodes.EntityTooLarge]: '内容超出长度限制',
            [RESTJSONErrorCodes.TooManyActions]: '操作过于频繁，请稍后再试',
            [RESTJSONErrorCodes.MaximumWebhooks]: '已达到Webhook数量上限'
        };
        return errorMessages[error.code] || `Discord API错误 (${error.code}): ${error.message}`;
    }
    return error.message || '未知错误';
};

/**
 * 检查用户权限并处理结果
 * @param {Interaction} interaction - Discord交互对象
 * @param {string[]} AdministratorRoleIds - 允许执行命令的管理员角色ID数组
 * @param {Object} [options] - 可选配置
 * @param {string} [options.errorMessage] - 自定义错误消息
 * @param {boolean} [options.checkChannelPermission] - 是否检查频道权限
 * @returns {Promise<boolean>} 如果用户有权限返回true，否则返回false
 */
export const checkAndHandlePermission = async (interaction, AdministratorRoleIds, options = {}) => {
    const hasGlobalPermission = interaction.member.roles.cache.some(role => 
        AdministratorRoleIds.includes(role.id)
    );

    // 如果需要检查频道权限
    if (options.checkChannelPermission && !hasGlobalPermission) {
        const channel = interaction.channel;
        // 如果是子区，检查父频道的权限
        if (channel.isThread()) {
            const parentPermissions = channel.parent.permissionsFor(interaction.member);
            if (parentPermissions.has('ManageMessages')) {
                return true;
            }
        } else {
            // 检查频道的权限
            const channelPermissions = channel.permissionsFor(interaction.member);
            if (channelPermissions.has('ManageMessages')) {
                return true;
            }
        }
    } else if (hasGlobalPermission) {
        return true;
    }

    // 如果没有权限，发送错误消息
    const errorMessage = options.errorMessage || '你没有权限使用此命令。需要具有指定的身份组权限。';
    await interaction.editReply({
        content: errorMessage,
        flags: ['Ephemeral']
    });
    return false;
};

/**
 * 检查用户是否具有特定频道的权限
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {Channel} channel - Discord频道对象
 * @param {string[]} AdministratorRoleIds - 允许执行命令的管理员角色ID数组
 * @returns {boolean} 如果用户拥有权限则返回true
 */
export const checkChannelPermission = (member, channel, AdministratorRoleIds) => {
    // 检查用户是否有全局身份组权限
    const hasGlobalPermission = member.roles.cache.some(role => AdministratorRoleIds.includes(role.id));
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
 * @param {string} [reason] - 操作原因
 * @param {Object} [options] - 可选配置
 * @param {boolean} [options.isAdmin=false] - 是否为管理员操作
 * @param {Object} [options.guildConfig] - 服务器配置（管理员操作必需）
 * @returns {Promise<void>}
 */
export const lockAndArchiveThread = async (thread, executor, reason, options = {}) => {
    // 如果是管理员操作，必须提供理由和服务器配置
    if (options.isAdmin) {
        if (!reason) {
            throw new Error('管理员必须提供锁定原因');
        }
        if (!options.guildConfig) {
            throw new Error('管理员操作必须提供服务器配置');
        }
    }

    // 确保有理由（非管理员可以使用默认理由）
    const finalReason = reason || '楼主已结束讨论';

    // 发送通知到帖子中
    await sendThreadNotification(thread, {
        title: options.isAdmin ? '管理员锁定并归档了此帖子' : '帖子已被锁定并归档',
        executorId: executor.id,
        reason: finalReason
    });

    // 如果是管理员操作，发送到管理日志
    if (options.isAdmin && options.guildConfig) {
        await sendModerationLog(thread.client, options.guildConfig.moderationLogThreadId, {
            title: '管理员锁定并归档帖子',
            executorId: executor.id,
            threadName: thread.name,
            threadUrl: thread.url,
            reason: finalReason
        });
    }

    // 执行锁定和归档操作
    await thread.setLocked(true, finalReason);
    await thread.setArchived(true, finalReason);
    
    // 记录日志
    const actorType = options.isAdmin ? '管理员' : '楼主';
    logTime(`${actorType} ${executor.tag} 锁定并归档了帖子 ${thread.name}`);
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
export const sendModerationLog = async (client, moderationChannelId, logData) => {
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
};

/**
 * 发送通知到帖子中
 * @param {ThreadChannel} thread - Discord帖子对象
 * @param {Object} notifyData - 通知数据
 * @param {string} notifyData.title - 通知标题
 * @param {string} notifyData.executorId - 执行者ID
 * @param {string} notifyData.reason - 操作原因
 */
export const sendThreadNotification = async (thread, notifyData) => {
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
};

/**
 * 生成进度报告
 * @param {number} current - 当前进度
 * @param {number} total - 总数
 * @param {Object} [options] - 可选配置
 * @param {string} [options.prefix=''] - 前缀文本
 * @param {string} [options.suffix=''] - 后缀文本
 * @param {boolean} [options.showPercentage=true] - 是否显示百分比
 * @param {boolean} [options.showNumbers=true] - 是否显示数字
 * @param {string} [options.progressChar='⏳'] - 进度指示符
 * @returns {string} 格式化的进度信息
 */
export const generateProgressReport = (current, total, options = {}) => {
    const {
        prefix = '',
        suffix = '',
        showPercentage = true,
        showNumbers = true,
        progressChar = '⏳'
    } = options;

    const progress = (current / total * 100).toFixed(1);
    const parts = [];

    if (prefix) parts.push(prefix);
    if (progressChar) parts.push(progressChar);
    if (showNumbers) parts.push(`${current}/${total}`);
    if (showPercentage) parts.push(`(${progress}%)`);
    if (suffix) parts.push(suffix);

    return parts.join(' ');
};

/**
 * 统一处理命令错误响应
 * @param {Interaction} interaction - Discord交互对象
 * @param {Error} error - 错误对象
 * @param {string} commandName - 命令名称
 */
export const handleCommandError = async (interaction, error, commandName) => {
    // 使用handleDiscordError处理Discord API错误
    const errorMessage = error instanceof DiscordAPIError ? 
        handleDiscordError(error) : 
        error.message;
    
    logTime(`${commandName}执行出错: ${errorMessage}`, true);
    
    try {
        if (interaction.deferred) {
            await interaction.editReply({
                content: `❌ ${errorMessage}`,
                flags: ['Ephemeral']
            });
        } else {
            await interaction.reply({
                content: `❌ ${errorMessage}`,
                flags: ['Ephemeral']
            });
        }
    } catch (replyError) {
        logTime(`发送错误响应失败: ${replyError}`, true);
    }
};

/**
 * 发送清理报告到管理频道
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} guildConfig - 服务器配置
 * @param {Object} result - 清理结果
 */
export const sendCleanupReport = async (interaction, guildConfig, result) => {
    const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationLogThreadId);
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
};

/**
 * 加载命令文件
 * @param {string} commandsDir - 命令文件目录的路径
 * @param {string[]} [excludeFiles=[]] - 要排除的文件名数组
 * @returns {Promise<Map<string, Object>>} 命令映射
 */
export const loadCommandFiles = async (commandsDir, excludeFiles = []) => {
    const commands = new Map();
    let errorCount = 0;
    
    try {
        const files = readdirSync(commandsDir)
            .filter(file => file.endsWith('.js') && !excludeFiles.includes(file));

        for (const file of files) {
            try {
                const commandPath = join(commandsDir, file);
                // 转换为 file:// URL
                const fileUrl = `file://${commandPath.replace(/\\/g, '/')}`;
                const command = await import(fileUrl);
                
                if (!command.default?.data?.name || !command.default.execute) {
                    errorCount++;
                    continue;
                }
                
                if (commands.has(command.default.data.name)) {
                    logTime(`⚠️ 重复命令名称 "${command.default.data.name}"`);
                    errorCount++;
                    continue;
                }

                commands.set(command.default.data.name, command.default);
            } catch (error) {
                errorCount++;
                logTime(`❌ 加载命令文件 ${file} 失败:`, true);
                console.error(error.stack);
            }
        }
        logTime(`命令加载完成，成功 ${commands.size} 个，失败 ${errorCount} 个`);
        return commands;
    } catch (error) {
        logTime(`❌ 读取命令目录失败:`, true);
        console.error(error.stack);
        return new Map();
    }
};

/**
 * 获取应用程序版本信息
 * @returns {Object|null} 包含版本号、提交哈希和提交日期的对象，如果获取失败则返回null
 */
export const getVersionInfo = () => {
    try {
        const currentDir = dirname(fileURLToPath(import.meta.url));
        const packagePath = join(currentDir, '..', 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        const version = 'v' + packageJson.version;
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitDate = execSync('git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();
        return {
            version,
            commitHash,
            commitDate
        };
    } catch (error) {
        logTime('获取版本信息失败: ' + error.message, true);
        return null;
    }
}; 