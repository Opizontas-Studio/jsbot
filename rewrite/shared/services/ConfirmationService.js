import { ConfirmationMessageBuilder } from '../builders/ConfirmationMessage.js';

// 服务注册配置
export const serviceConfig = {
    name: 'confirmationService',
    factory: (container) => new ConfirmationService({
        logger: container.get('logger')
    })
};

/**
 * 确认操作管理服务
 * 统一管理确认按钮的创建、验证和执行
 *
 */
export class ConfirmationService {
    constructor({ logger }) {
        this.logger = logger;
        // 存储待确认的操作：Map<confirmationId, { userId, expiresAt, onConfirm, context }>
        this.pendingConfirmations = new Map();

        // 定期清理过期的确认
        this.cleanupInterval = setInterval(() => this._cleanup(), 60000); // 每分钟清理一次
    }

    /**
     * 创建一个待确认的操作
     * @param {Object} options
     * @param {string} options.userId - 发起操作的用户ID
     * @param {Function} options.onConfirm - 确认后的回调函数 (confirmation, context) => Promise<{ logInfo?, logLevel? }>
     * @param {Function} [options.onError] - 错误处理回调函数 (error, confirmation, context) => Promise<{ logInfo?, logLevel? }>
     * @param {Object} options.context - 操作的上下文信息
     * @param {number} [options.timeout=120000] - 超时时间（毫秒）
     * @returns {string} 确认ID
     */
    createConfirmation({ userId, onConfirm, onError, context, timeout = 120000 }) {
        const confirmationId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

        this.pendingConfirmations.set(confirmationId, {
            userId,
            expiresAt: Date.now() + timeout,
            onConfirm,
            onError,
            context
        });

        this.logger.debug({
            msg: '[ConfirmationService] 创建待确认操作',
            confirmationId,
            userId,
            context: context?.type || 'unknown'
        });

        return confirmationId;
    }

    /**
     * 执行确认操作
     * @param {string} confirmationId - 确认ID
     * @param {string} userId - 点击按钮的用户ID
     * @param {Object} interaction - Discord交互对象
     * @returns {Promise<Object>} { success: boolean, error?: string }
     */
    async executeConfirmation(confirmationId, userId, interaction) {
        const confirmation = this.pendingConfirmations.get(confirmationId);

        if (!confirmation) {
            this.logger.warn({
                msg: '[ConfirmationService] 确认操作不存在或已过期',
                confirmationId,
                userId
            });
            return {
                success: false,
                error: '确认操作已过期或不存在'
            };
        }

        // 验证用户
        if (confirmation.userId !== userId) {
            this.logger.warn({
                msg: '[ConfirmationService] 用户无权执行此确认',
                confirmationId,
                expectedUserId: confirmation.userId,
                actualUserId: userId
            });
            return {
                success: false,
                error: '只有发起操作的用户才能确认'
            };
        }

        // 验证是否过期
        if (Date.now() > confirmation.expiresAt) {
            this.pendingConfirmations.delete(confirmationId);
            this.logger.warn({
                msg: '[ConfirmationService] 确认操作已过期',
                confirmationId,
                userId
            });
            return {
                success: false,
                error: '确认操作已过期'
            };
        }

        // 删除待确认操作
        this.pendingConfirmations.delete(confirmationId);

        // 执行回调并统一处理错误和日志
        try {
            const result = await confirmation.onConfirm(interaction, confirmation.context);

            // 记录成功日志
            if (result?.logInfo) {
                const logLevel = result.logLevel || 'info';
                this.logger[logLevel](result.logInfo);
            } else {
                this.logger.debug({
                    msg: '[ConfirmationService] 确认操作已执行',
                    confirmationId,
                    userId,
                    context: confirmation.context?.type || 'unknown'
                });
            }

            return { success: true };
        } catch (error) {
            // 如果提供了错误处理回调，调用它
            if (confirmation.onError) {
                try {
                    const result = await confirmation.onError(error, interaction, confirmation.context);

                    // 记录错误日志
                    if (result?.logInfo) {
                        const logLevel = result.logLevel || 'error';
                        this.logger[logLevel](result.logInfo);
                    } else {
                        this.logger.error({
                            msg: '[ConfirmationService] 确认回调执行失败（已处理）',
                            confirmationId,
                            userId,
                            error: error.message
                        });
                    }

                    return { success: true }; // 错误已被处理
                } catch (handlerError) {
                    // 错误处理器本身出错
                    this.logger.error({
                        msg: '[ConfirmationService] 错误处理器执行失败',
                        confirmationId,
                        userId,
                        originalError: error.message,
                        handlerError: handlerError.message
                    });
                    throw handlerError;
                }
            }

            // 没有错误处理回调，记录日志并重新抛出
            this.logger.error({
                msg: '[ConfirmationService] 确认回调执行失败',
                confirmationId,
                userId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 取消确认操作
     * @param {string} confirmationId - 确认ID
     */
    cancelConfirmation(confirmationId) {
        if (this.pendingConfirmations.delete(confirmationId)) {
            this.logger.debug({
                msg: '[ConfirmationService] 确认操作已取消',
                confirmationId
            });
        }
    }

    /**
     * 清理过期的确认操作
     * @private
     */
    _cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [id, confirmation] of this.pendingConfirmations) {
            if (now > confirmation.expiresAt) {
                this.pendingConfirmations.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.debug({
                msg: '[ConfirmationService] 清理过期确认',
                cleaned,
                remaining: this.pendingConfirmations.size
            });
        }
    }

    /**
     * 获取统计信息
     * @returns {Object}
     */
    getStats() {
        return {
            pending: this.pendingConfirmations.size
        };
    }

    /**
     * 清理资源
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.pendingConfirmations.clear();
    }

    // ==================== 便捷方法 ====================

    /**
     * 创建确认操作并返回消息内容
     * 这是最常用的方法，一步完成确认的创建和消息构建
     *
     * @param {Object} options - 配置选项
     * @param {string} options.userId - 用户ID
     * @param {Function} options.onConfirm - 确认回调 (confirmation, context) => Promise<{ logInfo?, logLevel? }>
     * @param {Function} [options.onError] - 错误处理回调 (error, confirmation, context) => Promise<{ logInfo?, logLevel? }>
     * @param {Object} options.context - 操作上下文
     * @param {string} options.title - 标题
     * @param {string} options.message - 消息内容
     * @param {string} [options.buttonLabel='确认'] - 按钮文本
     * @param {string} [options.buttonStyle='danger'] - 按钮样式
     * @param {Array<number>} [options.color] - 容器颜色
     * @param {number} [options.timeout=120000] - 超时时间（毫秒）
     * @returns {Object} { confirmationId, messagePayload: { components, actionRows } }
     */
    createConfirmationWithMessage({
        userId,
        onConfirm,
        onError,
        context,
        title,
        message,
        buttonLabel = '确认',
        buttonStyle = 'danger',
        color,
        timeout = 120000
    }) {
        // 创建待确认操作
        const confirmationId = this.createConfirmation({
            userId,
            onConfirm,
            onError,
            context,
            timeout
        });

        // 构建消息
        const messagePayload = ConfirmationMessageBuilder.createConfirmation({
            confirmationId,
            title,
            message,
            buttonLabel,
            buttonStyle,
            color,
            timeout
        });

        // messagePayload 现在已经是完整的消息对象（包含 components 和 flags）
        return {
            confirmationId,
            messagePayload
        };
    }
}

