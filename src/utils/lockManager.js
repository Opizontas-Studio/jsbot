import { logTime } from './logger.js';

/**
 * 锁管理器类
 * 提供简单有效的子区锁和服务器锁机制
 */
class LockManager {
    constructor() {
        // 子区级别的锁
        this.threadLocks = new Set();
        // 服务器级别的锁
        this.guildLocks = new Set();
        // 锁的超时时间（15分钟）
        this.lockTimeout = 15 * 60 * 1000;
        // 锁的超时清理器
        this.lockTimeouts = new Map();
    }

    /**
     * 尝试获取子区锁
     * @param {string} threadId - 子区ID
     * @param {string} operation - 操作名称（用于日志）
     * @returns {boolean} 是否成功获取锁
     */
    acquireThreadLock(threadId, operation = '未知操作') {
        if (this.threadLocks.has(threadId)) {
            logTime(`[锁管理] 子区 ${threadId} 已被锁定，操作 ${operation} 被阻止`);
            return false;
        }

        this.threadLocks.add(threadId);

        // 设置超时自动释放锁
        const timeoutId = setTimeout(() => {
            this.releaseThreadLock(threadId, '超时自动释放');
        }, this.lockTimeout);

        this.lockTimeouts.set(`thread_${threadId}`, timeoutId);
        return true;
    }

    /**
     * 释放子区锁
     * @param {string} threadId - 子区ID
     * @param {string} reason - 释放原因
     */
    releaseThreadLock(threadId, reason = '操作完成') {
        if (this.threadLocks.has(threadId)) {
            this.threadLocks.delete(threadId);

            // 清除超时器
            const timeoutId = this.lockTimeouts.get(`thread_${threadId}`);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.lockTimeouts.delete(`thread_${threadId}`);
            }
        }
    }

    /**
     * 尝试获取服务器锁
     * @param {string} guildId - 服务器ID
     * @param {string} operation - 操作名称
     * @returns {boolean} 是否成功获取锁
     */
    acquireGuildLock(guildId, operation = '未知操作') {
        if (this.guildLocks.has(guildId)) {
            logTime(`[锁管理] 服务器 ${guildId} 已被锁定，操作 ${operation} 被阻止`);
            return false;
        }

        this.guildLocks.add(guildId);

        // 设置超时自动释放锁
        const timeoutId = setTimeout(() => {
            this.releaseGuildLock(guildId, '超时自动释放');
        }, this.lockTimeout);

        this.lockTimeouts.set(`guild_${guildId}`, timeoutId);
        return true;
    }

    /**
     * 释放服务器锁
     * @param {string} guildId - 服务器ID
     * @param {string} reason - 释放原因
     */
    releaseGuildLock(guildId, reason = '操作完成') {
        if (this.guildLocks.has(guildId)) {
            this.guildLocks.delete(guildId);

            // 清除超时器
            const timeoutId = this.lockTimeouts.get(`guild_${guildId}`);
            if (timeoutId) {
                clearTimeout(timeoutId);
                this.lockTimeouts.delete(`guild_${guildId}`);
            }
        }
    }

    /**
     * 检查子区是否被锁定
     * @param {string} threadId - 子区ID
     * @returns {boolean} 是否被锁定
     */
    isThreadLocked(threadId) {
        return this.threadLocks.has(threadId);
    }

    /**
     * 检查服务器是否被锁定
     * @param {string} guildId - 服务器ID
     * @returns {boolean} 是否被锁定
     */
    isGuildLocked(guildId) {
        return this.guildLocks.has(guildId);
    }

    /**
     * 获取锁状态信息
     * @returns {Object} 锁状态统计
     */
    getLockStatus() {
        return {
            threadLocks: this.threadLocks.size,
            guildLocks: this.guildLocks.size,
            lockedThreads: Array.from(this.threadLocks),
            lockedGuilds: Array.from(this.guildLocks)
        };
    }

    /**
     * 等待并获取子区锁（自动排队等待机制）
     * @param {string} threadId - 子区ID
     * @param {string} operation - 操作名称
     * @param {number} maxWaitTime - 最大等待时间（毫秒，默认5分钟）
     * @returns {Promise<boolean>} 是否成功获取锁
     */
    async waitAndAcquireThreadLock(threadId, operation = '未知操作', maxWaitTime = 300000) {
        const startTime = Date.now();
        let waitCount = 0;

        while (Date.now() - startTime < maxWaitTime) {
            if (this.acquireThreadLock(threadId, operation)) {
                if (waitCount > 0) {
                    logTime(`[锁管理] 子区 ${threadId} 等待 ${waitCount} 次后成功获取锁，操作: ${operation}`);
                }
                return true;
            }

            waitCount++;

            // 每次等待10秒，最多等待5分钟
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        logTime(`[锁管理] 子区 ${threadId} 等待超时（${maxWaitTime/1000}秒），操作 ${operation} 被取消`, true);
        return false;
    }

    /**
     * 等待并获取服务器锁（自动排队等待机制）
     * @param {string} guildId - 服务器ID
     * @param {string} operation - 操作名称
     * @param {number} maxWaitTime - 最大等待时间（毫秒，默认5分钟）
     * @returns {Promise<boolean>} 是否成功获取锁
     */
    async waitAndAcquireGuildLock(guildId, operation = '未知操作', maxWaitTime = 300000) {
        const startTime = Date.now();
        let waitCount = 0;

        while (Date.now() - startTime < maxWaitTime) {
            if (this.acquireGuildLock(guildId, operation)) {
                if (waitCount > 0) {
                    logTime(`[锁管理] 服务器 ${guildId} 等待 ${waitCount} 次后成功获取锁，操作: ${operation}`);
                }
                return true;
            }

            waitCount++;

            // 每次等待10秒，最多等待5分钟
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        logTime(`[锁管理] 服务器 ${guildId} 等待超时（${maxWaitTime/1000}秒），操作 ${operation} 被取消`, true);
        return false;
    }

    /**
     * 清理所有锁（用于系统关闭时）
     */
    cleanup() {
        // 清除所有超时器
        for (const timeoutId of this.lockTimeouts.values()) {
            clearTimeout(timeoutId);
        }

        this.lockTimeouts.clear();
        this.threadLocks.clear();
        this.guildLocks.clear();

        logTime('[锁管理] 所有锁已清理');
    }
}

// 创建全局锁管理器实例
export const globalLockManager = new LockManager();
