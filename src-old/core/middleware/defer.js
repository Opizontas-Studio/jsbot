/**
 * Defer中间件
 * 自动调用 interaction.deferReply()
 */
export async function deferMiddleware(ctx, next, config) {
    // 跳过不支持defer的交互
    if (ctx.interaction.isAutocomplete?.()) {
        return await next();
    }

    // 选择菜单的useUpdate模式不需要defer
    if (config.useUpdate) {
        ctx.useUpdate = true;
        return await next();
    }

    if (!config.defer) {
        return await next();
    }

    // 解析defer配置
    const ephemeral = typeof config.defer === 'object' ? config.defer.ephemeral !== false : true;

    try {
        await ctx.defer(ephemeral);
    } catch (error) {
        ctx.logger?.warn({
            msg: 'Defer 失败',
            error: error.message,
            userId: ctx.user.id,
            commandName: ctx.interaction.commandName
        });
        throw error;
    }

    await next();
}
