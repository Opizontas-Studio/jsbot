import { DiscordAPIError } from '@discordjs/rest';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { logTime } from './logger.js';

/**
 * 统一错误处理工具类
 * 提供一层包装，直接完成错误处理全流程
 */
export class ErrorHandler {
    /**
     * Discord API 错误映射表
     */
    static discordErrorMap = {
        [RESTJSONErrorCodes.UnknownChannel]: '频道不存在或无法访问',
        [RESTJSONErrorCodes.MissingAccess]: '缺少访问权限',
        [RESTJSONErrorCodes.UnknownMessage]: '消息不存在或已被删除',
        [RESTJSONErrorCodes.MissingPermissions]: '缺少所需权限',
        [RESTJSONErrorCodes.CannotSendMessagesToThisUser]: '无法向该用户发送消息',
        [RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged]: '交互已确认',
        [RESTJSONErrorCodes.RequestEntityTooLarge]: '内容超出长度限制',
        [RESTJSONErrorCodes.InvalidFormBodyOrContentType]: '请求内容格式错误',
        [RESTJSONErrorCodes.CannotExecuteActionOnDMChannel]: '无法在私信中执行此操作',
        [RESTJSONErrorCodes.MaximumActiveThreads]: '已达到最大活跃子区数量',
        [RESTJSONErrorCodes.ThreadLocked]: '子区已锁定',
    };

    /**
     * 获取用户友好的错误消息
     * @private
     */
    static getUserMessage(error) {
        if (error instanceof DiscordAPIError) {
            return this.discordErrorMap[error.code] || `Discord API错误 (${error.code})`;
        }
        return error.message || '操作失败，请稍后重试';
    }

    /**
     * 服务层错误处理装饰器
     * @param {Function} operation - 异步操作函数
     * @param {string} context - 错误上下文描述
     * @param {Object} options - 配置选项
     * @param {boolean} [options.throwOnError=false] - 是否在错误时抛出异常（而非返回错误对象）
     * @param {boolean} [options.userFriendly=true] - 是否返回用户友好消息
     * @returns {Promise<{success: boolean, data?: any, error?: string} | any>}
     *          当throwOnError=false时返回结果对象，当throwOnError=true时直接返回数据或抛出错误
     */
    static async handleService(operation, context, options = {}) {
        const { throwOnError = false, userFriendly = true } = options;

        try {
            const result = await operation();

            // 如果要求抛出错误模式，直接返回数据
            if (throwOnError) {
                return result;
            }

            return { success: true, data: result };
        } catch (error) {
            const userMessage = userFriendly ? '操作失败，请稍后重试' : this.getUserMessage(error);
            const logMessage = `[${context}] ${error.message}`;

            logTime(logMessage, true);

            if (throwOnError) {
                throw error;
            }

            return { success: false, error: userMessage };
        }
    }

    /**
     * 交互式错误处理装饰器（自动回复用户）
     * @param {Object} interaction - Discord交互对象
     * @param {Function} operation - 异步操作函数
     * @param {string} context - 错误上下文描述
     * @param {Object} options - 配置选项
     * @param {boolean} [options.ephemeral=true] - 错误消息是否私密
     * @param {string} [options.successMessage] - 成功时的消息
     * @returns {Promise<{success: boolean, data?: any}>}
     */
    static async handleInteraction(interaction, operation, context, options = {}) {
        const { ephemeral = true, successMessage } = options;

        try {
            const result = await operation();

            if (successMessage) {
                const replyData = {
                    content: `✅ ${successMessage}`,
                    flags: ephemeral ? ['Ephemeral'] : undefined
                };

                if (interaction.deferred) {
                    await interaction.editReply(replyData);
                } else {
                    await interaction.reply(replyData);
                }
            }

            return { success: true, data: result };
        } catch (error) {
            const userMessage = this.getUserMessage(error);
            const logMessage = `[${context}] ${error.message}`;

            logTime(logMessage, true);

            // 发送错误回复
            const errorReply = {
                content: `❌ ${userMessage}`,
                flags: ephemeral ? ['Ephemeral'] : undefined
            };

            try {
                if (interaction.deferred) {
                    await interaction.editReply(errorReply);
                } else if (!interaction.replied) {
                    await interaction.reply(errorReply);
                }
            } catch (replyError) {
                logTime(`[${context}] 发送错误回复失败: ${replyError.message}`, true);
            }

            return { success: false };
        }
    }

    /**
     * 静默错误处理（仅记录日志，不抛出）
     * @param {Function} operation - 异步操作函数
     * @param {string} context - 错误上下文描述
     * @param {any} [fallback=null] - 失败时的默认返回值
     * @returns {Promise<any>}
     */
    static async handleSilent(operation, context, fallback = null) {
        try {
            return await operation();
        } catch (error) {
            logTime(`[${context}] ${error.message}`, true);
            return fallback;
        }
    }

    /**
     * 批量操作错误处理（收集成功和失败的结果）
     * @param {Array} items - 要处理的项目数组
     * @param {Function} operation - 对每个项目执行的操作
     * @param {string} context - 错误上下文描述
     * @returns {Promise<{successes: Array, failures: Array}>}
     */
    static async handleBatch(items, operation, context) {
        const successes = [];
        const failures = [];

        for (const item of items) {
            try {
                const result = await operation(item);
                successes.push({ item, result });
            } catch (error) {
                logTime(`[${context}] 项目 ${JSON.stringify(item)} 处理失败: ${error.message}`, true);
                failures.push({ item, error: error.message });
            }
        }

        return { successes, failures };
    }

    /**
     * 重试机制错误处理
     * @param {Function} operation - 要重试的操作
     * @param {string} context - 错误上下文描述
     * @param {Object} options - 重试配置
     * @param {number} [options.maxRetries=3] - 最大重试次数
     * @param {number} [options.delay=1000] - 重试延迟(毫秒)
     * @returns {Promise<any>}
     */
    static async handleWithRetry(operation, context, options = {}) {
        const { maxRetries = 3, delay = 1000 } = options;

        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (attempt < maxRetries) {
                    logTime(`[${context}] 第${attempt}次尝试失败，${delay}ms后重试: ${error.message}`, true);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    logTime(`[${context}] 所有重试均失败: ${error.message}`, true);
                }
            }
        }

        throw lastError;
    }

    /**
     * 同步版本的服务层错误处理装饰器
     * @param {Function} operation - 同步操作函数
     * @param {string} context - 错误上下文描述
     * @param {Object} options - 配置选项
     * @param {boolean} [options.throwOnError=false] - 是否在错误时抛出异常（而非返回错误对象）
     * @param {boolean} [options.userFriendly=true] - 是否返回用户友好消息
     * @returns {{success: boolean, data?: any, error?: string} | any}
     *          当throwOnError=false时返回结果对象，当throwOnError=true时直接返回数据或抛出错误
     */
    static handleServiceSync(operation, context, options = {}) {
        const { throwOnError = false, userFriendly = true } = options;

        try {
            const result = operation();

            // 如果要求抛出错误模式，直接返回数据
            if (throwOnError) {
                return result;
            }

            return { success: true, data: result };
        } catch (error) {
            const userMessage = userFriendly ? '操作失败，请稍后重试' : this.getUserMessage(error);
            const logMessage = `[${context}] ${error.message}`;

            logTime(logMessage, true);

            if (throwOnError) {
                throw error;
            }

            return { success: false, error: userMessage };
        }
    }
}

/**
 * 快速创建成功/错误/信息回复内容
 */
export const ReplyBuilder = {
    success: (message, ephemeral = false) => ({
        content: `✅ ${message}`,
        flags: ephemeral ? ['Ephemeral'] : undefined
    }),

    error: (message, ephemeral = true) => ({
        content: `❌ ${message}`,
        flags: ephemeral ? ['Ephemeral'] : undefined
    }),

    info: (message, ephemeral = false) => ({
        content: `ℹ️ ${message}`,
        flags: ephemeral ? ['Ephemeral'] : undefined
    }),

    warning: (message, ephemeral = false) => ({
        content: `⚠️ ${message}`,
        flags: ephemeral ? ['Ephemeral'] : undefined
    })
};
