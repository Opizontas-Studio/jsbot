/**
 * 队列中间件
 * 将处理器包装到队列管理器中执行，控制并发和优先级
 */
export function queueMiddleware(queueManager) {
    return async (ctx, next, config) => {
        // 如果配置中没有指定队列选项，直接执行
        if (!config?.queue) {
            return await next();
        }

        // 从配置中获取队列选项
        const queueOptions = {
            priority: config.queue.priority || 'normal',
            timeout: config.queue.timeout,
            taskName: config.id || ctx.interaction.commandName || '未命名任务',
            taskId: `${config.type}:${config.id}:${ctx.interaction.id}`
        };

        ctx.logger?.debug({
            msg: '[Queue] 任务加入队列',
            taskName: queueOptions.taskName,
            priority: queueOptions.priority
        });

        // 将后续执行包装到队列中
        return await queueManager.add(
            async () => await next(),
            queueOptions
        );
    };
}

