import { DiscordAPIError } from '@discordjs/rest';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';

/**
 * 错误格式化工具类
 * 提供统一的错误消息格式化功能
 */
export class ErrorFormatter {
    /**
     * Discord API 错误代码映射表
     */
    static DISCORD_ERROR_MESSAGES = {
        [RESTJSONErrorCodes.UnknownChannel]: '频道不存在或无法访问',
        [RESTJSONErrorCodes.MissingAccess]: '缺少访问权限',
        [RESTJSONErrorCodes.UnknownMessage]: '消息不存在或已被删除',
        [RESTJSONErrorCodes.MissingPermissions]: '缺少所需权限',
        [RESTJSONErrorCodes.CannotSendMessagesToThisUser]: '无法向该用户发送消息',
        [RESTJSONErrorCodes.ReactionWasBlocked]: '表情反应被阻止',
        [RESTJSONErrorCodes.MaximumActiveThreads]: '已达到最大活跃子区数量',
        [RESTJSONErrorCodes.ThreadLocked]: '子区已锁定',
        [RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged]: '交互已确认',
        [RESTJSONErrorCodes.RequestEntityTooLarge]: '内容超出长度限制',
        [RESTJSONErrorCodes.InvalidFormBodyOrContentType]: '请求内容格式错误',
        [RESTJSONErrorCodes.CannotExecuteActionOnDMChannel]: '无法在私信中执行此操作',
        [RESTJSONErrorCodes.UnknownUser]: '用户不存在',
        [RESTJSONErrorCodes.UnknownMember]: '成员不存在',
        [RESTJSONErrorCodes.UnknownRole]: '角色不存在',
        [RESTJSONErrorCodes.UnknownGuild]: '服务器不存在',
        [RESTJSONErrorCodes.InvalidOAuth2State]: 'OAuth2 状态无效',
        [RESTJSONErrorCodes.MissingResourceOwner]: '缺少资源所有者',
        [RESTJSONErrorCodes.InvalidMessageType]: '消息类型无效',
        [RESTJSONErrorCodes.CannotDeleteMessageInAnotherUsersChannel]: '无法删除其他用户频道中的消息',
    };

    /**
     * 网络错误代码映射表
     */
    static NETWORK_ERROR_CODES = {
        'ECONNRESET': '网络连接中断',
        'ETIMEDOUT': '网络连接超时',
        'ECONNREFUSED': '连接被拒绝',
        'ENOTFOUND': '无法解析主机',
        'ENETUNREACH': '网络不可达',
    };

    /**
     * 格式化错误消息为用户友好的文本
     * @param {Error} error - 错误对象
     * @param {Object} options - 格式化选项
     * @param {boolean} [options.includeCode=false] - 是否包含错误代码
     * @param {boolean} [options.verbose=false] - 是否显示详细错误信息
     * @returns {string} 用户友好的错误消息
     */
    static format(error, options = {}) {
        const { includeCode = false, verbose = false } = options;

        // Discord API 错误
        if (error instanceof DiscordAPIError) {
            const message = this.DISCORD_ERROR_MESSAGES[error.code] || `Discord API错误`;

            if (includeCode) {
                return `${message} (代码: ${error.code})`;
            }

            if (verbose && !this.DISCORD_ERROR_MESSAGES[error.code]) {
                return `${message}: ${error.message}`;
            }

            return message;
        }

        // 业务逻辑错误（自定义错误）
        if (error.name === 'BusinessError') {
            return error.message;
        }

        // 网络错误
        if (error.code && this.NETWORK_ERROR_CODES[error.code]) {
            return `${this.NETWORK_ERROR_CODES[error.code]}，请稍后重试`;
        }

        // 超时错误
        if (this._isTimeoutError(error)) {
            return '操作超时，请稍后重试';
        }

        // 权限错误
        if (this._isPermissionError(error)) {
            return '权限不足，无法执行此操作';
        }

        // 未知错误
        if (verbose) {
            return `发生错误: ${error.message}`;
        }

        return '发生未知错误，请稍后重试或联系管理员';
    }

    /**
     * 获取 Discord API 错误的友好消息
     * @param {number} code - Discord API 错误代码
     * @returns {string|null} 错误消息，如果未找到则返回 null
     */
    static getDiscordErrorMessage(code) {
        return this.DISCORD_ERROR_MESSAGES[code] || null;
    }

    /**
     * 检查是否为超时错误
     * @private
     * @param {Error} error - 错误对象
     * @returns {boolean}
     */
    static _isTimeoutError(error) {
        const message = error.message?.toLowerCase() || '';
        return message.includes('timeout') ||
               message.includes('超时') ||
               message.includes('timed out');
    }

    /**
     * 检查是否为权限相关错误
     * @private
     * @param {Error} error - 错误对象
     * @returns {boolean}
     */
    static _isPermissionError(error) {
        const message = error.message?.toLowerCase() || '';
        return message.includes('permission') ||
               message.includes('权限') ||
               message.includes('forbidden');
    }

    /**
     * 格式化错误用于日志记录
     * @param {Error} error - 错误对象
     * @param {Object} context - 错误上下文信息
     * @returns {Object} 格式化的日志对象
     */
    static formatForLog(error, context = {}) {
        const logData = {
            message: error.message,
            name: error.name,
            stack: error.stack,
            ...context
        };

        // Discord API 错误的额外信息
        if (error instanceof DiscordAPIError) {
            logData.discordCode = error.code;
            logData.discordStatus = error.status;
            logData.discordMethod = error.method;
            logData.discordUrl = error.url;
        }

        // 网络错误的额外信息
        if (error.code) {
            logData.errorCode = error.code;
        }

        return logData;
    }
}

