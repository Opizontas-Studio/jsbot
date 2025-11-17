/**
 * Discord API调用监控
 * 负责监控速率限制、响应状态等
 */
class ApiMonitor {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
        this.stats = {
            rateLimitHits: 0,
            errors429: 0,
            errors401: 0,
            totalRequests: 0
        };
    }

    /**
     * 启动监控
     */
    start() {
        this._registerRestEvents();
        this.logger.debug('[ApiMonitor] 已启动');
    }

    /**
     * 停止监控（清理事件监听器由Application统一处理）
     */
    stop() {
        this.logger.debug('[ApiMonitor] 已停止');
    }

    /**
     * 注册REST API事件监听
     * @private
     */
    _registerRestEvents() {
        // 监听速率限制
        this.client.rest.on('rateLimited', rateLimitData => {
            this.stats.rateLimitHits++;

            this.logger.warn({
                msg: '[API] 遇到速率限制',
                route: rateLimitData.route,
                method: rateLimitData.method,
                timeToReset: `${rateLimitData.timeToReset}ms`,
                global: rateLimitData.global ? '是' : '否',
                limit: rateLimitData.limit || '未知'
            });
        });

        // 监听响应状态
        this.client.rest.on('response', (request, response) => {
            this.stats.totalRequests++;

            // 记录429错误（速率限制）
            if (response.status === 429) {
                this.stats.errors429++;
                this.logger.error({
                    msg: '[API] 受到速率限制（429）',
                    route: request.route,
                    method: request.method,
                    status: response.status,
                    retryAfter: response.headers.get('retry-after') || '未知'
                });
            }

            // Token失效检测（401）
            if (response.status === 401) {
                this.stats.errors401++;
                this.logger.error({
                    msg: '[API] Token验证失败（401）',
                    route: request.route,
                    method: request.method
                });

                // 根据plan.md设计，不自动重连，而是记录错误让运维处理
                this.logger.error('[系统] 检测到Token失效，请检查配置后重启Bot');
            }

            // 记录其他4xx/5xx错误
            if (response.status >= 400 && response.status !== 401 && response.status !== 429) {
                this.logger.error({
                    msg: '[API] 请求失败',
                    route: request.route,
                    method: request.method,
                    status: response.status
                });
            }
        });
    }

    /**
     * 获取统计信息
     * @returns {Object}
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * 重置统计信息
     */
    resetStats() {
        this.stats = {
            rateLimitHits: 0,
            errors429: 0,
            errors401: 0,
            totalRequests: 0
        };
    }
}

export { ApiMonitor };

