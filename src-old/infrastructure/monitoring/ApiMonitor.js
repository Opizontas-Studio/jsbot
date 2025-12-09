/**
 * Discord REST API底层监控
 * 监听Discord.js REST客户端的底层事件（速率限制、HTTP错误等）
 */
export class ApiMonitor {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;

        // 事件监听器引用（用于清理）
        this.listeners = [];

        // 定时器引用
        this.intervals = [];

        // 统计信息
        this.stats = {
            // 速率限制统计
            rateLimitHits: 0, // 主动等待次数
            rateLimitExceeded: 0, // 被429次数

            // HTTP错误统计
            errors429: 0, // 速率限制错误
            errors401: 0, // 认证失败
            errors403: 0, // 权限不足
            errors404: 0, // 资源不存在
            errors5xx: 0, // 服务器错误
            errorsOther: 0, // 其他错误

            // 请求统计
            totalRequests: 0, // 总请求数
            successRequests: 0, // 成功请求数（2xx）

            // 时间窗口统计（用于计算请求频率）
            requestsInWindow: [],
            windowSize: 60000 // 1分钟窗口
        };
    }

    /**
     * 启动监控
     */
    start() {
        this._registerRestEvents();

        // 定期清理过期的时间窗口数据
        const cleanupInterval = setInterval(() => {
            const now = Date.now();
            const cutoff = now - this.stats.windowSize;
            this.stats.requestsInWindow = this.stats.requestsInWindow.filter(timestamp => timestamp > cutoff);
        }, 10000);
        this.intervals.push(cleanupInterval);

        this.logger.debug('[ApiMonitor] REST底层监控已启动');
    }

    /**
     * 停止监控
     */
    stop() {
        // 清理所有定时器
        for (const intervalId of this.intervals) {
            clearInterval(intervalId);
        }
        this.intervals = [];

        // 移除所有事件监听器
        for (const { emitter, eventName, listener } of this.listeners) {
            if (emitter && listener) {
                emitter.off(eventName, listener);
            }
        }
        this.listeners = [];

        this.logger.debug('[ApiMonitor] 监控已停止');
    }

    /**
     * 注册REST API事件监听
     * @private
     */
    _registerRestEvents() {
        // 监听速率限制事件（主动等待）
        const rateLimitedListener = rateLimitData => {
            this.stats.rateLimitHits++;

            // 只有触发了实际的延迟才记录警告
            if (rateLimitData.timeToReset > 100) {
                this.logger.warn({
                    msg: '[REST] 触发速率限制等待',
                    route: rateLimitData.route,
                    method: rateLimitData.method,
                    timeout: `${rateLimitData.timeToReset}ms`,
                    limit: rateLimitData.limit || '未知',
                    global: rateLimitData.global || false
                });
            }

            // 如果是全局限制，特别警告
            if (rateLimitData.global) {
                this.logger.error({
                    msg: '[REST] 触发全局速率限制！',
                    timeout: `${rateLimitData.timeToReset}ms`,
                    limit: rateLimitData.limit
                });
                this.stats.rateLimitExceeded++;
            }
        };

        // 监听响应事件
        const responseListener = (request, response) => {
            this.stats.totalRequests++;
            this.stats.requestsInWindow.push(Date.now());

            const status = response.status;

            // 成功响应（2xx）
            if (status >= 200 && status < 300) {
                this.stats.successRequests++;
                return;
            }

            // 429 - 速率限制错误（说明主动限速失败了）
            if (status === 429) {
                this.stats.errors429++;
                this.stats.rateLimitExceeded++;

                const retryAfter = response.headers?.get('retry-after') || response.headers?.['retry-after'];

                this.logger.error({
                    msg: '[REST] 收到429错误 - 主动限速未能阻止',
                    route: request.route,
                    method: request.method,
                    retryAfter: retryAfter ? `${retryAfter}秒` : '未知'
                });
                return;
            }

            // 401 - Token验证失败
            if (status === 401) {
                this.stats.errors401++;

                this.logger.error({
                    msg: '[REST] Token验证失败（401）',
                    route: request.route,
                    method: request.method
                });

                // 严重错误，提示需要人工介入
                this.logger.error('[系统] ⚠️ Bot Token失效，需要检查配置并重启');
                return;
            }

            // 403 - 权限不足
            if (status === 403) {
                this.stats.errors403++;

                this.logger.warn({
                    msg: '[REST] 权限不足（403）',
                    route: request.route,
                    method: request.method
                });
                return;
            }

            // 404 - 资源不存在
            if (status === 404) {
                this.stats.errors404++;

                this.logger.debug({
                    msg: '[REST] 资源不存在（404）',
                    route: request.route,
                    method: request.method
                });
                return;
            }

            // 5xx - 服务器错误
            if (status >= 500) {
                this.stats.errors5xx++;

                this.logger.error({
                    msg: '[REST] Discord服务器错误（5xx）',
                    route: request.route,
                    method: request.method,
                    status
                });
                return;
            }

            // 其他4xx错误
            if (status >= 400) {
                this.stats.errorsOther++;

                this.logger.warn({
                    msg: '[REST] 请求错误',
                    route: request.route,
                    method: request.method,
                    status
                });
            }
        };

        // 注册事件监听器
        this.client.rest.on('rateLimited', rateLimitedListener);
        this.listeners.push({
            emitter: this.client.rest,
            eventName: 'rateLimited',
            listener: rateLimitedListener
        });

        this.client.rest.on('response', responseListener);
        this.listeners.push({
            emitter: this.client.rest,
            eventName: 'response',
            listener: responseListener
        });
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        // 清理过期数据
        const now = Date.now();
        const cutoff = now - this.stats.windowSize;
        this.stats.requestsInWindow = this.stats.requestsInWindow.filter(timestamp => timestamp > cutoff);

        const rps = (this.stats.requestsInWindow.length / (this.stats.windowSize / 1000)).toFixed(2);
        const successRate =
            this.stats.totalRequests > 0
                ? ((this.stats.successRequests / this.stats.totalRequests) * 100).toFixed(1)
                : 100;

        return {
            summary: {
                totalRequests: this.stats.totalRequests,
                successRequests: this.stats.successRequests,
                successRate: `${successRate}%`,
                rps: parseFloat(rps)
            },
            rateLimit: {
                hits: this.stats.rateLimitHits,
                exceeded: this.stats.rateLimitExceeded,
                errors429: this.stats.errors429
            },
            errors: {
                errors401: this.stats.errors401,
                errors403: this.stats.errors403,
                errors404: this.stats.errors404,
                errors5xx: this.stats.errors5xx,
                errorsOther: this.stats.errorsOther,
                total:
                    this.stats.errors401 +
                    this.stats.errors403 +
                    this.stats.errors404 +
                    this.stats.errors429 +
                    this.stats.errors5xx +
                    this.stats.errorsOther
            }
        };
    }

    /**
     * 重置统计信息
     */
    reset() {
        this.stats.rateLimitHits = 0;
        this.stats.rateLimitExceeded = 0;
        this.stats.errors429 = 0;
        this.stats.errors401 = 0;
        this.stats.errors403 = 0;
        this.stats.errors404 = 0;
        this.stats.errors5xx = 0;
        this.stats.errorsOther = 0;
        this.stats.totalRequests = 0;
        this.stats.successRequests = 0;
        this.stats.requestsInWindow = [];

        this.logger.debug('[ApiMonitor] 统计已重置');
    }
}
