import { DiscordAPIError } from '@discordjs/rest';
import { execSync } from 'child_process';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { readFileSync } from 'fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logTime } from './logger.js';

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
export const handleDiscordError = error => {
    if (error instanceof DiscordAPIError) {
        const errorMessages = {
            [RESTJSONErrorCodes.UnknownChannel]: '频道不存在或无法访问',
            [RESTJSONErrorCodes.MissingAccess]: '缺少访问权限',
            [RESTJSONErrorCodes.UnknownMessage]: '消息不存在或已被删除',
            [RESTJSONErrorCodes.MissingPermissions]: '缺少所需权限',
            [RESTJSONErrorCodes.CannotSendMessagesToThisUser]: '无法向该用户发送消息',
            [RESTJSONErrorCodes.ReactionWasBlocked]: '表情反应被阻止',
            [RESTJSONErrorCodes.MaximumActiveThreads]: '已达到最大活跃子区数量',
            [RESTJSONErrorCodes.MaximumThreadParticipantsReached]: '子区成员已达上限',
            [RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage]: '已存在相同消息的子区',
            [RESTJSONErrorCodes.ThreadLocked]: '子区已锁定',
            [RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged]: '交互已确认',
            [RESTJSONErrorCodes.RequestEntityTooLarge]: '内容超出长度限制',
            [RESTJSONErrorCodes.MissingPermissions]: '缺少权限',
            [RESTJSONErrorCodes.InvalidFormBodyOrContentType]: '请求内容格式错误',
            [RESTJSONErrorCodes.InvalidToken]: 'Bot令牌无效',
            [RESTJSONErrorCodes.CannotExecuteActionOnDMChannel]: '无法在私信中执行此操作',
            [RESTJSONErrorCodes.InvalidRecipients]: '无效的接收者',
            [RESTJSONErrorCodes.MaximumNumberOfEmojisReached]: '已达到表情数量上限',
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
    const hasGlobalPermission = interaction.member.roles.cache.some(role => AdministratorRoleIds.includes(role.id));

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
        flags: ['Ephemeral'],
    });
    return false;
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
        reason: finalReason,
    });

    // 如果是管理员操作，发送到管理日志
    if (options.isAdmin && options.guildConfig) {
        await sendModerationLog(thread.client, options.guildConfig.moderationLogThreadId, {
            title: '管理员锁定并归档帖子',
            executorId: executor.id,
            threadName: thread.name,
            threadUrl: thread.url,
            reason: finalReason,
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
        embeds: [
            {
                color: 0x0099ff,
                title: logData.title,
                fields: [
                    {
                        name: '操作人',
                        value: `<@${logData.executorId}>`,
                        inline: true,
                    },
                    {
                        name: '主题',
                        value: `[${logData.threadName}](${logData.threadUrl})`,
                        inline: true,
                    },
                    {
                        name: '原因',
                        value: logData.reason,
                        inline: false,
                    },
                ],
                timestamp: new Date(),
                footer: {
                    text: '论坛管理系统',
                },
            },
        ],
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
        embeds: [
            {
                color: 0xffcc00,
                title: notifyData.title,
                fields: [
                    {
                        name: '操作人',
                        value: `<@${notifyData.executorId}>`,
                        inline: true,
                    },
                    {
                        name: '原因',
                        value: notifyData.reason,
                        inline: true,
                    },
                ],
                timestamp: new Date(),
            },
        ],
    });
};

/**
 * 统一处理命令错误响应
 * @param {Interaction} interaction - Discord交互对象
 * @param {Error} error - 错误对象
 * @param {string} commandName - 命令名称
 */
export const handleCommandError = async (interaction, error, commandName) => {
    // 使用handleDiscordError处理Discord API错误
    const errorMessage = error instanceof DiscordAPIError ? handleDiscordError(error) : error.message;

    logTime(`${commandName}执行出错: ${errorMessage}`, true);

    try {
        if (interaction.deferred) {
            await interaction.editReply({
                content: `❌ ${errorMessage}`,
                flags: ['Ephemeral'],
            });
        } else {
            await interaction.reply({
                content: `❌ ${errorMessage}`,
                flags: ['Ephemeral'],
            });
        }
    } catch (replyError) {
        logTime(`发送错误响应失败: ${replyError}`, true);
    }
};

/**
 * 统一处理非命令交互错误响应
 * @param {Interaction} interaction - Discord交互对象
 * @param {Error} error - 错误对象
 * @param {string} interactionType - 交互类型（如：'button', 'modal'）
 */
export const handleInteractionError = async (interaction, error, interactionType) => {
    // 获取错误消息
    const errorMessage = error instanceof DiscordAPIError ? handleDiscordError(error) : error.message;

    // 记录详细错误日志
    logTime(`${interactionType}交互出错: ${errorMessage}`, true);

    try {
        // 用户可见的错误消息
        const userMessage =
            error instanceof DiscordAPIError ? handleDiscordError(error) : '处理请求时出现错误，请稍后重试';

        // 根据交互状态发送响应
        if (interaction.deferred) {
            await interaction.editReply({
                content: `❌ ${userMessage}`,
                flags: ['Ephemeral'],
            });
        } else if (!interaction.replied) {
            await interaction.reply({
                content: `❌ ${userMessage}`,
                flags: ['Ephemeral'],
            });
        }
        // 如果已经replied但不是deferred，只记录日志
    } catch (replyError) {
        // 如果发送错误响应也失败，记录额外日志
        logTime(`发送错误响应失败: ${replyError.message}`, true);
    }
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
        const files = readdirSync(commandsDir).filter(file => file.endsWith('.js') && !excludeFiles.includes(file));

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
        logTime('❌ 读取命令目录失败:', true);
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
        const packagePath = join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        const version = 'v' + packageJson.version;
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitDate = execSync('git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();
        return {
            version,
            commitHash,
            commitDate,
        };
    } catch (error) {
        logTime('获取版本信息失败: ' + error.message, true);
        return null;
    }
};

/**
 * 验证图片链接
 * @param {string} url - 图片链接
 * @returns {{isValid: boolean, error: string|null}} 验证结果
 */
export function validateImageUrl(url) {
    if (!url) return { isValid: true, error: null }; // 允许为空

    try {
        const urlObj = new URL(url);

        // 检查协议
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return { isValid: false, error: '图片链接必须使用 http 或 https 协议' };
        }

        // 检查文件扩展名
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        if (!allowedExtensions.some(ext => urlObj.pathname.toLowerCase().endsWith(ext))) {
            return {
                isValid: false,
                error: '图片链接必须以 .jpg、.jpeg、.png、.gif 或 .webp 结尾',
            };
        }

        return { isValid: true, error: null };
    } catch (error) {
        return { isValid: false, error: '无效的图片链接格式' };
    }
}
