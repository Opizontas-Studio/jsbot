import { ErrorFormatter } from '../../shared/utils/ErrorFormatter.js';

/**
 * 执行包装中间件
 * 合并了操作追踪和错误处理，作为最外层中间件
 * 职责：
 * 1. 追踪活跃操作（用于模块重载安全检查）
 * 2. 捕获所有错误并统一处理
 */
export function executionWrapperMiddleware(tracker) {
    return async (ctx, next, config) => {
        // 提取操作信息
        const operationId = ctx.interaction.id;
        const userId = ctx.user?.id || 'unknown';

        // 从 config.id 提取模块名称（格式：moduleName.commandName）
        let moduleName = null;
        let commandName = null;

        if (config?.id) {
            const parts = config.id.split('.');
            if (parts.length >= 2) {
                moduleName = parts[0];
                commandName = parts.slice(1).join('.');
            }
        }

        try {
            // 开始追踪（如果有有效的模块信息）
            if (moduleName && commandName) {
                tracker.startTracking(operationId, {
                    moduleName,
                    commandName,
                    userId
                });

                ctx.logger?.debug({
                    msg: '[ExecutionWrapper] 开始处理交互',
                    commandName,
                    moduleName,
                    userId,
                    interactionType: ctx.interaction.type
                });
            }

            // 执行后续中间件和处理器
            await next();

        } catch (error) {
            // 记录详细错误日志
            ctx.logger?.error({
                msg: '交互处理错误',
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
                userId,
                guildId: ctx.guild?.id,
                interactionType: ctx.interaction.type,
                interactionId: ctx.interaction.id,
                commandName: ctx.interaction.commandName || commandName,
                moduleName
            });

            // 回复用户友好的错误消息
            try {
                const errorMessage = ErrorFormatter.format(error);
                await ctx.error(errorMessage, true);
            } catch (replyError) {
                ctx.logger?.error({
                    msg: '发送错误回复失败',
                    originalError: error.message,
                    replyError: replyError.message
                });
            }
        } finally {
            // 无论成功还是失败，都停止追踪
            if (moduleName && commandName) {
                tracker.stopTracking(operationId);
            }
        }
    };
}

