import { ErrorFormatter } from '../../shared/utils/ErrorFormatter.js';

/**
 * 错误处理中间件
 * 包裹整个执行链，捕获错误并自动回复
 */
export async function errorHandlerMiddleware(ctx, next) {
    try {
        ctx.logger?.debug({
            msg: '[ErrorHandler] 开始处理交互',
            commandName: ctx.interaction.commandName,
            userId: ctx.user?.id,
            interactionType: ctx.interaction.type
        });

        await next();
    } catch (error) {
        // 记录详细错误日志
        ctx.logger?.error({
            msg: '交互处理错误',
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack,
            userId: ctx.user?.id,
            guildId: ctx.guild?.id,
            interactionType: ctx.interaction.type,
            interactionId: ctx.interaction.id,
            commandName: ctx.interaction.commandName
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
    }
}
