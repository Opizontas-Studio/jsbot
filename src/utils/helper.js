import { DiscordAPIError } from '@discordjs/rest';
import { execSync } from 'child_process';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { readFileSync } from 'fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EmbedFactory } from '../factories/embedFactory.js';
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
 * 超时控制工具函数
 * @param {Promise} promise - 要执行的Promise
 * @param {number} ms - 超时时间（毫秒），默认10秒
 * @param {string} context - 操作上下文描述
 * @returns {Promise} 返回结果或超时错误
 */
export const withTimeout = async (promise, ms = 10000, context = '') => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`操作超时: ${context}`)), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
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
 * 检查用户是否有指定角色权限并处理结果
 * @param {Interaction} interaction - Discord交互对象
 * @param {string[]} roleIds - 允许执行命令的角色ID数组
 * @param {Object} [options] - 可选配置
 * @param {string} [options.errorMessage] - 自定义错误消息
 * @returns {Promise<boolean>} 如果用户有权限返回true，否则返回false
 */
export const checkAndHandlePermission = async (interaction, roleIds, options = {}) => {
    const hasPermission = interaction.member.roles.cache.some(role => roleIds.includes(role.id));

    if (!hasPermission) {
        const errorContent = {
            content: options.errorMessage || '你没有权限使用此命令。需要具有指定的身份组。',
            flags: ['Ephemeral'],
        };

        // 根据交互状态选择正确的响应方法
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errorContent);
        } else {
            await interaction.reply(errorContent);
        }
    }

    return hasPermission;
};

/**
 * 检查用户是否有管理员或版主权限并处理结果
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} guildConfig - 服务器配置
 * @param {Object} [options] - 可选配置
 * @param {boolean} [options.requireForumPermission=false] - 是否要求版主同时具有论坛权限
 * @param {string} [options.customErrorMessage] - 自定义错误消息
 * @returns {Promise<boolean>} 如果用户有权限返回true，否则返回false
 */
export const checkModeratorPermission = async (interaction, guildConfig, options = {}) => {
    const hasAdminRole = interaction.member.roles.cache.some(role =>
        guildConfig.AdministratorRoleIds.includes(role.id),
    );
    const hasModRole = interaction.member.roles.cache.some(role =>
        guildConfig.ModeratorRoleIds.includes(role.id) ||
        (guildConfig.roleApplication?.QAerRoleId && role.id === guildConfig.roleApplication.QAerRoleId)
    );

    let hasPermission = hasAdminRole;

    if (!hasPermission && hasModRole) {
        if (options.requireForumPermission) {
            // 如果需要论坛权限，检查用户是否有管理消息的权限
            const parentChannel = interaction.channel.parent;
            const hasForumPermission = parentChannel.permissionsFor(interaction.member).has('ManageMessages');
            hasPermission = hasForumPermission;
        } else {
            hasPermission = true;
        }
    }

    if (!hasPermission) {
        const defaultError = options.requireForumPermission
            ? '你没有权限执行此操作。需要具有管理员身份组或（恰当身份组+该论坛的消息管理权限）。'
            : '你没有权限执行此操作。需要具有管理员或恰当身份组。';

        const errorContent = {
            content: options.customErrorMessage || defaultError,
            flags: ['Ephemeral'],
        };

        // 根据交互状态选择正确的响应方法
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errorContent);
        } else {
            await interaction.reply(errorContent);
        }
    }

    return hasPermission;
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
        description: '💡 **如需解锁帖子请使用 /申请解锁帖子 命令**',
    });

    // 如果是管理员操作，发送到管理日志
    if (options.isAdmin && options.guildConfig) {
        await sendModerationLog(thread.client, options.guildConfig.threadLogThreadId, {
            title: '管理员锁定并归档帖子',
            executorId: executor.id,
            threadName: thread.name,
            threadUrl: thread.url,
            reason: finalReason,
            additionalInfo: thread.ownerId ? `帖子作者: <@${thread.ownerId}>` : undefined,
        });

        // 向帖子作者发送私聊通知
        if (thread.ownerId) {
            try {
                const threadOwner = await thread.client.users.fetch(thread.ownerId);
                const dmEmbed = EmbedFactory.createThreadLockDMEmbed(
                    executor.id,
                    thread.name,
                    thread.url,
                    finalReason
                );

                await threadOwner.send({ embeds: [dmEmbed] });
                logTime(`已向帖子作者 ${threadOwner.tag} 发送锁定通知私信`);
            } catch (error) {
                logTime(`无法向帖子作者发送私信通知：${error.message}`, true);
            }
        }
    }

    // 执行锁定和归档操作
    await thread.setLocked(true, finalReason);
    await thread.setArchived(true, finalReason);

    // 记录日志
    const actorType = options.isAdmin ? '管理员' : '[自助管理] 楼主';
    logTime(`${actorType} ${executor.tag} 锁定并归档了帖子 ${thread.name}`);
};

/**
 * 发送管理操作日志到指定频道
 * @param {Client} client - Discord客户端
 * @param {string} moderationChannelId - 管理日志频道ID
 * @param {Object} logData - 日志数据
 * @param {string} logData.title - 日志标题
 * @param {string} logData.executorId - 执行者ID
 * @param {string} logData.threadName - 帖子名称
 * @param {string} [logData.threadUrl] - 帖子链接（可选，对于删除操作可能不提供）
 * @param {string} logData.reason - 操作原因
 * @param {string} [logData.additionalInfo] - 额外信息（可选）
 */
export const sendModerationLog = async (client, moderationChannelId, logData) => {
    const moderationChannel = await client.channels.fetch(moderationChannelId);

    // 构建字段数组
    const fields = [
        {
            name: '操作人',
            value: `<@${logData.executorId}>`,
            inline: true,
        },
    ];

    // 根据是否有帖子链接决定主题字段的内容
    if (logData.threadUrl) {
        fields.push({
            name: '主题',
            value: `[${logData.threadName}](${logData.threadUrl})`,
            inline: true,
        });
    } else {
        fields.push({
            name: '主题',
            value: logData.threadName,
            inline: true,
        });
    }

    fields.push({
        name: '原因',
        value: logData.reason,
        inline: false,
    });

    // 如果有额外信息，添加到字段中
    if (logData.additionalInfo) {
        fields.push({
            name: '额外信息',
            value: logData.additionalInfo,
            inline: false,
        });
    }

    await moderationChannel.send({
        embeds: [
            {
                color: 0x0099ff,
                title: logData.title,
                fields: fields,
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
 * @param {string} [notifyData.description] - 可选的额外描述信息
 */
export const sendThreadNotification = async (thread, notifyData) => {
    const embed = {
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
    };

    // 添加可选的描述信息
    if (notifyData.description) {
        embed.description = notifyData.description;
    }

    await thread.send({
        embeds: [embed],
    });
};

/**
 * 统一处理命令错误响应
 * @param {Interaction} interaction - Discord交互对象
 * @param {Error} error - 错误对象
 * @param {string} commandName - 命令名称
 */
export const handleCommandError = async (interaction, error, commandName) => {
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
 * 加载命令文件
 * @param {string} commandsDir - 命令文件目录的路径
 * @param {string[]} [excludeFiles=[]] - 要排除的文件名数组
 * @returns {Promise<Map<string, Object>>} 命令映射
 */
export const loadCommandFiles = async (commandsDir, excludeFiles = []) => {
    const commands = new Map();
    let errorCount = 0;

    try {
        // 递归加载所有子目录中的命令文件
        const loadDirectory = async (dir) => {
            const items = readdirSync(dir, { withFileTypes: true });

            for (const item of items) {
                const itemPath = join(dir, item.name);

                if (item.isDirectory()) {
                    // 递归加载子目录
                    await loadDirectory(itemPath);
                } else if (item.isFile() && item.name.endsWith('.js') && !excludeFiles.includes(item.name)) {
                    // 加载命令文件
                    try {
                        const fileUrl = `file://${itemPath.replace(/\\/g, '/')}`;
                        const command = await import(fileUrl);

                        // 处理单个命令或命令数组
                        const commandList = Array.isArray(command.default) ? command.default : [command.default];

                        for (const cmd of commandList) {
                            if (!cmd?.data?.name || !cmd.execute) {
                                logTime(`❌ 加载命令文件 ${item.name} 失败: 缺少必要的data.name或execute属性`);
                                errorCount++;
                                continue;
                            }

                            if (commands.has(cmd.data.name)) {
                                logTime(`⚠️ 重复命令名称 "${cmd.data.name}" 在文件 ${item.name}`);
                                errorCount++;
                                continue;
                            }

                            commands.set(cmd.data.name, cmd);
                        }
                    } catch (error) {
                        errorCount++;
                        logTime(`❌ 加载命令文件 ${item.name} 失败:`, true);
                        console.error(error.stack);
                    }
                }
            }
        };

        await loadDirectory(commandsDir);

        logTime(`[系统启动] 命令加载完成，成功 ${commands.size} 个，失败 ${errorCount} 个`);
        return commands;
    } catch (error) {
        logTime('[系统启动] 读取命令目录失败:', true);
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
 * 验证上传的图片文件
 * @param {Object} attachment - Discord Attachment对象
 * @returns {{isValid: boolean, error: string|null}} 验证结果
 */
export function validateImageFile(attachment) {
    if (!attachment) return { isValid: true, error: null }; // 允许为空

    // 检查MIME类型
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(attachment.contentType)) {
        return {
            isValid: false,
            error: '仅支持JPG、PNG、GIF或WebP格式的图片',
        };
    }

    // 检查文件大小（限制为10MB）
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (attachment.size > maxSize) {
        return {
            isValid: false,
            error: '图片大小不能超过10MB',
        };
    }

    return { isValid: true, error: null };
};

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
 * 验证警告时长并返回计算结果
 * @param {string} warnTime - 警告时长字符串 (如 "30d")
 * @param {number} [maxDays=90] - 最大允许天数，默认90天
 * @returns {{isValid: boolean, duration: number|null, error: string|null}} 验证结果
 */
export const validateWarningDuration = (warnTime, maxDays = 90) => {
    if (!warnTime) {
        return { isValid: true, duration: null, error: null };
    }

    const duration = calculatePunishmentDuration(warnTime);
    if (duration === -1) {
        return { isValid: false, duration: null, error: '无效的警告时长格式' };
    }

    // 检查警告时长是否超过最大天数
    const MAX_WARNING_TIME = maxDays * 24 * 60 * 60 * 1000;
    if (duration > MAX_WARNING_TIME) {
        return { isValid: false, duration: null, error: `警告时长不能超过${maxDays}天` };
    }

    return { isValid: true, duration, error: null };
};
