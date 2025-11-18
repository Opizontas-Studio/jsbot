import AsyncLock from 'async-lock';

/**
 * 锁管理器
 * 基于 async-lock 库，提供资源级别的互斥锁和读写锁
 */
export class LockManager {
    /**
     * @param {Object} options - 配置选项
     * @param {number} [options.timeout] - 锁超时时间（毫秒），默认15分钟
     * @param {number} [options.maxPending] - 最大等待队列长度，默认1000
     */
    constructor(options = {}) {
        const timeout = options.timeout ?? 900000; // 默认15分钟
        const maxPending = options.maxPending ?? 1000; // 默认1000

        this.lock = new AsyncLock({
            timeout,
            maxPending,
            Promise: Promise
        });

        this.logger = null; // 将由容器注入
        this.lockStats = new Map(); // 统计信息
    }

    /**
     * 设置日志器（容器注入后调用）
     * @param {Object} logger - 日志器实例
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * 获取资源锁键
     * @private
     */
    _getKey(resource, id) {
        return `${resource}:${id}`;
    }

    /**
     * 记录锁统计信息
     * @private
     */
    _recordStats(key, operation, duration) {
        if (!this.lockStats.has(key)) {
            this.lockStats.set(key, {
                acquireCount: 0,
                totalWaitTime: 0,
                maxWaitTime: 0,
                failureCount: 0
            });
        }

        const stats = this.lockStats.get(key);
        if (operation === 'acquire') {
            stats.acquireCount++;
            stats.totalWaitTime += duration;
            stats.maxWaitTime = Math.max(stats.maxWaitTime, duration);
        } else if (operation === 'failure') {
            stats.failureCount++;
        }
    }

    /**
     * 获取锁并执行函数
     * @param {string} resource - 资源类型（thread/guild/user/process等）
     * @param {string} id - 资源ID
     * @param {Function} fn - 要执行的函数
     * @param {Object} [options] - 选项
     * @param {number} [options.timeout] - 自定义超时时间
     * @param {string} [options.operation] - 操作名称（用于日志）
     * @returns {Promise<any>} 函数返回值
     */
    async acquire(resource, id, fn, options = {}) {
        const key = this._getKey(resource, id);
        const operation = options.operation || '未知操作';
        const startTime = Date.now();

        try {
            this.logger?.debug(`[锁管理] 尝试获取锁: ${key} (${operation})`);

            const result = await this.lock.acquire(key, fn, {
                timeout: options.timeout
            });

            const duration = Date.now() - startTime;
            this._recordStats(key, 'acquire', duration);

            if (duration > 1000) {
                this.logger?.info(`[锁管理] 获取锁成功: ${key} (${operation}) - 等待 ${duration}ms`);
            } else {
                this.logger?.debug(`[锁管理] 获取锁成功: ${key} (${operation}) - 等待 ${duration}ms`);
            }

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this._recordStats(key, 'failure', duration);

            if (error.message?.includes('timeout')) {
                this.logger?.warn(`[锁管理] 获取锁超时: ${key} (${operation}) - ${duration}ms`);
                throw new Error(`资源 ${resource}:${id} 正在被其他操作占用，请稍后重试`);
            }

            this.logger?.error(`[锁管理] 获取锁失败: ${key} (${operation})`, error);
            throw error;
        }
    }

    /**
     * 检查资源是否被锁定
     * @param {string} resource - 资源类型
     * @param {string} id - 资源ID
     * @returns {boolean} 是否被锁定
     */
    isBusy(resource, id) {
        const key = this._getKey(resource, id);
        return this.lock.isBusy(key);
    }

    /**
     * 获取锁统计信息
     * @param {string} [resource] - 资源类型（可选，不提供则返回所有）
     * @param {string} [id] - 资源ID（可选）
     * @returns {Object|Map} 统计信息
     */
    getStats(resource, id) {
        if (resource && id) {
            const key = this._getKey(resource, id);
            return this.lockStats.get(key) || null;
        }

        if (resource) {
            const prefix = `${resource}:`;
            const stats = {};
            for (const [key, value] of this.lockStats.entries()) {
                if (key.startsWith(prefix)) {
                    stats[key] = value;
                }
            }
            return stats;
        }

        return new Map(this.lockStats);
    }

    /**
     * 清除统计信息
     * @param {string} [resource] - 资源类型（可选）
     * @param {string} [id] - 资源ID（可选）
     */
    clearStats(resource, id) {
        if (resource && id) {
            const key = this._getKey(resource, id);
            this.lockStats.delete(key);
        } else if (resource) {
            const prefix = `${resource}:`;
            for (const key of this.lockStats.keys()) {
                if (key.startsWith(prefix)) {
                    this.lockStats.delete(key);
                }
            }
        } else {
            this.lockStats.clear();
        }
    }

    /**
     * 便捷方法：获取子区锁
     * @param {string} threadId - 子区ID
     * @param {Function} fn - 要执行的函数
     * @param {Object} [options] - 选项
     * @returns {Promise<any>}
     */
    async acquireThreadLock(threadId, fn, options = {}) {
        return this.acquire('thread', threadId, fn, {
            operation: options.operation || '线程操作',
            ...options
        });
    }

    /**
     * 便捷方法：获取服务器锁
     * @param {string} guildId - 服务器ID
     * @param {Function} fn - 要执行的函数
     * @param {Object} [options] - 选项
     * @returns {Promise<any>}
     */
    async acquireGuildLock(guildId, fn, options = {}) {
        return this.acquire('guild', guildId, fn, {
            operation: options.operation || '服务器操作',
            ...options
        });
    }

    /**
     * 便捷方法：获取用户锁
     * @param {string} userId - 用户ID
     * @param {Function} fn - 要执行的函数
     * @param {Object} [options] - 选项
     * @returns {Promise<any>}
     */
    async acquireUserLock(userId, fn, options = {}) {
        return this.acquire('user', userId, fn, {
            operation: options.operation || '用户操作',
            ...options
        });
    }

    /**
     * 获取锁状态摘要
     * @returns {Object} 状态摘要
     */
    getSummary() {
        const summary = {
            totalLocks: this.lockStats.size,
            byResource: {},
            topContended: []
        };

        // 按资源类型分组统计
        for (const [key, stats] of this.lockStats.entries()) {
            const [resource] = key.split(':');
            if (!summary.byResource[resource]) {
                summary.byResource[resource] = {
                    count: 0,
                    totalAcquires: 0,
                    totalFailures: 0
                };
            }

            const resourceStats = summary.byResource[resource];
            resourceStats.count++;
            resourceStats.totalAcquires += stats.acquireCount;
            resourceStats.totalFailures += stats.failureCount;
        }

        // 找出最拥挤的资源
        const contention = Array.from(this.lockStats.entries())
            .map(([key, stats]) => ({
                key,
                contention: stats.totalWaitTime / Math.max(stats.acquireCount, 1),
                failures: stats.failureCount
            }))
            .sort((a, b) => b.contention - a.contention)
            .slice(0, 10);

        summary.topContended = contention;

        return summary;
    }

    /**
     * 清理资源（优雅关闭时调用）
     */
    async cleanup() {
        this.logger?.debug('[锁管理] 开始清理资源');

        // async-lock 会自动处理未完成的锁
        // 这里只需要清理统计信息
        const summary = this.getSummary();
        if (summary.totalLocks > 0) {
            this.logger?.info('[锁管理] 锁统计摘要:', summary);
        }

        this.lockStats.clear();
        this.logger?.info('[锁管理] 资源清理完成');
    }
}
