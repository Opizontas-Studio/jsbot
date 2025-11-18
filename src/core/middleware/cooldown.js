/**
 * 冷却检查中间件
 * 使用CooldownManager控制执行频率
 */
export function cooldownMiddleware(cooldownManager) {
    return async (ctx, next, config) => {
        if (!config.cooldown) {
            return await next();
        }

        const cooldownKey = `${config.type}:${config.id}:${ctx.user.id}`;
        const remainingTime = cooldownManager.check(cooldownKey, config.cooldown);

        if (remainingTime > 0) {
            ctx.logger?.debug({
                msg: '冷却中',
                userId: ctx.user.id,
                configId: config.id,
                remaining: remainingTime
            });

            await ctx.error(`此操作冷却中，请等待 ${Math.ceil(remainingTime / 1000)} 秒后再试`, true);
            return;
        }

        cooldownManager.set(cooldownKey);
        await next();
    };
}
