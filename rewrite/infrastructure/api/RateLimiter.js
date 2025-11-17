/**
 * Discord API 速率限制器
 * 主动限速，避免触发 429 错误
 */
export class RateLimiter {
    /**
     * @param {Object} config - 配置选项
     * @param {Object} config.global - 全局限制配置
     * @param {Object} config.routes - 路由限制配置
     */
    constructor(config = {}) {
        this.config = {
            global: config.global || { maxRequests: 50, window: 1000 },
            routes: config.routes || {}
        };

        // 全局限制
        this.globalLimit = {
            maxRequests: this.config.global.maxRequests,
            window: this.config.global.window,
            requests: []
        };

        // 路由限制
        this.routeLimits = new Map();

        this.logger = null; // 将由容器注入
    }

    /**
     * 设置日志器（容器注入后调用）
     * @param {Object} logger - 日志器实例
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * 识别路由键
     * @param {string} method - HTTP方法（如：POST、GET、DELETE等）
     * @param {string} endpoint - API端点（如：/channels/:id/messages）
     * @param {Object} params - 路由参数
     * @returns {string} 路由键
     */
    _getRouteKey(method, endpoint, params = {}) {
        // 替换参数占位符
        let route = endpoint;
        for (const [key, value] of Object.entries(params)) {
            route = route.replace(`:${key}`, value);
        }

        return `${method} ${route}`;
    }

    /**
     * 获取路由限制配置
     * @private
     */
    _getRouteLimitConfig(routeKey) {
        // 尝试精确匹配
        if (this.config.routes[routeKey]) {
            return this.config.routes[routeKey];
        }

        // 尝试模糊匹配（将具体ID替换为占位符）
        const normalizedKey = routeKey.replace(/\/\d{17,19}/g, '/:id');
        if (this.config.routes[normalizedKey]) {
            return this.config.routes[normalizedKey];
        }

        // 使用默认配置
        return { maxRequests: 40, window: 1000 };
    }

    /**
     * 获取或创建路由限制器
     * @private
     */
    _getRouteLimiter(routeKey) {
        if (!this.routeLimits.has(routeKey)) {
            const config = this._getRouteLimitConfig(routeKey);
            this.routeLimits.set(routeKey, {
                maxRequests: config.maxRequests,
                window: config.window,
                requests: []
            });
        }
        return this.routeLimits.get(routeKey);
    }

    /**
     * 清理限制器中的过期请求
     * @private
     */
    _cleanExpiredRequests(limiter, now) {
        limiter.requests = limiter.requests.filter(
            time => now - time < limiter.window
        );
    }

    /**
     * 获取限制器中的活跃请求数
     * @private
     */
    _getActiveRequestCount(limiter, now) {
        return limiter.requests.filter(
            time => now - time < limiter.window
        ).length;
    }

    /**
     * 等待速率限制
     * @param {string} method - HTTP方法
     * @param {string} endpoint - API端点
     * @param {Object} [params] - 路由参数
     * @returns {Promise<void>}
     */
    async waitForRateLimit(method, endpoint, params = {}) {
        const routeKey = this._getRouteKey(method, endpoint, params);
        const routeLimiter = this._getRouteLimiter(routeKey);

        let waitCount = 0;

        while (true) {
            const now = Date.now();

            // 清理过期的请求记录
            this._cleanExpiredRequests(this.globalLimit, now);
            this._cleanExpiredRequests(routeLimiter, now);

            // 检查是否可以发送请求
            if (
                this.globalLimit.requests.length < this.globalLimit.maxRequests &&
                routeLimiter.requests.length < routeLimiter.maxRequests
            ) {
                // 记录请求时间
                this.globalLimit.requests.push(now);
                routeLimiter.requests.push(now);

                if (waitCount > 0) {
                    this.logger?.debug(`[速率限制] ${routeKey} - 等待了 ${waitCount} 次后通过`);
                }

                return;
            }

            // 计算需要等待的时间
            const globalOldest = this.globalLimit.requests[0] || now;
            const routeOldest = routeLimiter.requests[0] || now;
            const globalWait = globalOldest + this.globalLimit.window - now;
            const routeWait = routeOldest + routeLimiter.window - now;
            const waitTime = Math.max(globalWait, routeWait, 100); // 至少等待100ms

            waitCount++;

            if (waitCount === 1) {
                this.logger?.debug(`[速率限制] ${routeKey} - 需要等待 ${waitTime}ms`);
            }

            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    /**
     * 获取路由统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        const now = Date.now();
        const routeStats = {};

        for (const [routeKey, limiter] of this.routeLimits.entries()) {
            const activeRequests = this._getActiveRequestCount(limiter, now);

            routeStats[routeKey] = {
                maxRequests: limiter.maxRequests,
                window: limiter.window,
                activeRequests,
                utilization: ((activeRequests / limiter.maxRequests) * 100).toFixed(1) + '%'
            };
        }

        const globalActiveRequests = this._getActiveRequestCount(this.globalLimit, now);

        return {
            global: {
                maxRequests: this.globalLimit.maxRequests,
                window: this.globalLimit.window,
                activeRequests: globalActiveRequests,
                utilization: ((globalActiveRequests / this.globalLimit.maxRequests) * 100).toFixed(1) + '%'
            },
            routes: routeStats
        };
    }

    /**
     * 清理过期的记录
     */
    cleanup() {
        const now = Date.now();

        // 清理全局记录
        this._cleanExpiredRequests(this.globalLimit, now);

        // 清理路由记录
        for (const limiter of this.routeLimits.values()) {
            this._cleanExpiredRequests(limiter, now);
        }

        // 移除没有活跃请求的路由
        for (const [routeKey, limiter] of this.routeLimits.entries()) {
            if (limiter.requests.length === 0) {
                this.routeLimits.delete(routeKey);
            }
        }
    }

    /**
     * 重置所有限制（测试用）
     */
    reset() {
        this.globalLimit.requests = [];
        this.routeLimits.clear();
        this.logger?.debug('[速率限制] 已重置所有限制');
    }
}

