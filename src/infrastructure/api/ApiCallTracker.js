/**
 * API调用追踪器（轻量级版本）
 * 记录基本的调用统计，用于监控
 */
export class ApiCallTracker {
    constructor() {
        this.totalCalls = 0;
        this.successCalls = 0;
        this.failedCalls = 0;
        this.totalDuration = 0;
        this.recentCalls = [];
        this.maxRecentCalls = 10;
    }

    /**
     * 记录API调用
     * @param {Object} callInfo - 调用信息
     * @param {string} callInfo.methodName - 方法名
     * @param {string} callInfo.httpMethod - HTTP方法
     * @param {string} callInfo.endpoint - 端点
     * @param {boolean} callInfo.success - 是否成功
     * @param {number} callInfo.duration - 耗时（毫秒）
     * @param {string} [callInfo.error] - 错误信息
     */
    recordCall(callInfo) {
        const { methodName, httpMethod, endpoint, success, duration, error } = callInfo;
        const timestamp = Date.now();

        // 更新总体统计
        this.totalCalls++;
        this.totalDuration += duration;

        if (success) {
            this.successCalls++;
        } else {
            this.failedCalls++;
        }

        // 记录到最近调用列表
        this.recentCalls.unshift({
            methodName,
            httpMethod,
            endpoint,
            success,
            duration,
            error,
            timestamp
        });

        // 限制最近调用列表长度
        if (this.recentCalls.length > this.maxRecentCalls) {
            this.recentCalls.pop();
        }
    }

    /**
     * 停止追踪器
     */
    stop() {
        // 轻量级版本无需清理
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        const avgDuration = this.totalCalls > 0
            ? (this.totalDuration / this.totalCalls).toFixed(2)
            : 0;

        const successRate = this.totalCalls > 0
            ? ((this.successCalls / this.totalCalls) * 100).toFixed(1)
            : 100;

        return {
            summary: {
                totalCalls: this.totalCalls,
                successCalls: this.successCalls,
                failedCalls: this.failedCalls,
                avgDuration: `${avgDuration}ms`,
                successRate: `${successRate}%`
            },
            recentCalls: this.recentCalls
        };
    }

    /**
     * 重置统计信息
     */
    reset() {
        this.totalCalls = 0;
        this.successCalls = 0;
        this.failedCalls = 0;
        this.totalDuration = 0;
        this.recentCalls = [];
    }
}
