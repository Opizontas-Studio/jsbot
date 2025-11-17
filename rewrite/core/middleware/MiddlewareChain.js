/**
 * 中间件链
 * 按顺序执行中间件：errorHandler → defer → usage → permissions → cooldown → handler
 */
class MiddlewareChain {
    constructor(middlewares = []) {
        this.middlewares = middlewares;
    }

    /**
     * 添加中间件
     * @param {Function} middleware - 中间件函数
     */
    use(middleware) {
        this.middlewares.push(middleware);
    }

    /**
     * 执行中间件链
     * @param {Context} ctx - 上下文对象
     * @param {Object} config - 配置对象
     * @param {Function} handler - 最终处理函数
     */
    async execute(ctx, config, handler) {
        let index = -1;

        const dispatch = async (i) => {
            if (i <= index) {
                throw new Error('next() 被多次调用');
            }

            index = i;

            // 如果执行完所有中间件，调用handler
            if (i === this.middlewares.length) {
                return await handler();
            }

            const middleware = this.middlewares[i];

            // 传递next函数到中间件
            return await middleware(ctx, () => dispatch(i + 1), config);
        };

        return await dispatch(0);
    }
}

export { MiddlewareChain };

