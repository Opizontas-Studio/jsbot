import { logTime } from './logger.js';

/**
 * 全局请求队列
 * 用于控制和序列化异步请求
 */
export class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxConcurrent = 10;
        this.currentProcessing = 0;
        this.maxWaitTime = 30000; // 最大等待时间
        this.maxRetries = 3; // 最大重试次数
        this.stats = {
            processed: 0,
            failed: 0,
            retried: 0
        };
        this.paused = false; // 队列暂停状态
        this.shardStatus = new Map(); // 分片状态追踪
        // 定义有效的状态集合
        this.validStates = new Set(['ready', 'disconnected', 'reconnecting', 'error', 'resumed']);
        // 添加状态检查定时器
        this.statusCheckInterval = null;
        this.lastActivityTimestamp = Date.now();
        this.startStatusCheck();
    }

    // 记录活动时间
    updateActivityTimestamp() {
        this.lastActivityTimestamp = Date.now();
    }

    // 获取最后活动时间到现在的间隔
    getInactivityDuration() {
        return Date.now() - this.lastActivityTimestamp;
    }

    // 添加状态检查机制
    startStatusCheck() {
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
        }
        
        this.statusCheckInterval = setInterval(() => {
            const inactivityDuration = this.getInactivityDuration();
            const currentStatus = this.shardStatus.get(0);

            // 检查队列健康状态
            if (this.queue.length > 0 && !this.processing && !this.paused) {
                logTime('检测到队列停滞，尝试恢复处理');
                this.process();
            }

            // 增加网络连接状态检查
            if (currentStatus === 'reconnecting') {
                // 如果重连时间超过30秒，强制清理队列
                if (inactivityDuration > 30000) {
                    logTime('重连时间过长，执行队列清理');
                    this.cleanup().catch(error => {
                        logTime(`队列清理失败: ${error.message}`, true);
                    });
                    return;
                }
            }

            // 检查是否需要重置队列状态
            if (inactivityDuration > 60000) { // 60秒无活动
                logTime('检测到长时间无活动，重置队列状态');
                this.resetQueueState();
            }
        }, 5000); // 每5秒检查一次
    }

    // 新增重置队列状态方法
    async resetQueueState() {
        if (!this.paused) {
            this.pause();
        }
        await this.cleanup();
        this.currentProcessing = 0;
        this.processing = false;
        this.paused = false;
        logTime('队列状态已重置');
        this.resume();
    }

    // 清理资源
    async cleanup() {
        // 停止状态检查
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }

        // 等待当前正在处理的任务完成
        if (this.currentProcessing > 0) {
            logTime(`等待 ${this.currentProcessing} 个正在处理的任务完成...`);
            while (this.currentProcessing > 0) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // 清理剩余的队列任务
        if (this.queue.length > 0) {
            logTime(`清理剩余的 ${this.queue.length} 个队列任务`);
            for (const item of this.queue) {
                item.reject(new Error('队列正在关闭'));
            }
            this.queue = [];
        }

        this.processing = false;
        this.currentProcessing = 0;
        this.shardStatus.clear();
        logTime('请求队列资源已完全清理');
    }

    // 设置分片状态
    async setShardStatus(shardId, status) {
        if (!this.validStates.has(status)) {
            throw new Error(`无效的分片状态: ${status}`);
        }

        const oldStatus = this.shardStatus.get(shardId);
        
        if (oldStatus === status) {
            return;
        }

        // 记录状态变更
        this.shardStatus.set(shardId, status);
        this.updateActivityTimestamp();
        
        // 更新队列状态
        switch (status) {
            case 'disconnected':
            case 'error':
                // 立即执行清理
                this.pause();
                await this.cleanup();
                break;
            case 'reconnecting':
                if (oldStatus === 'disconnected' || oldStatus === 'error') {
                    this.pause();
                    // 设置重连超时
                    setTimeout(async () => {
                        if (this.shardStatus.get(shardId) === 'reconnecting') {
                            logTime('重连超时，执行清理');
                            await this.cleanup();
                        }
                    }, 30000);
                }
                break;
            case 'ready':
            case 'resumed':
                if (this.isAllShardsHealthy()) {
                    // 重置队列状态后恢复
                    await this.resetQueueState();
                    this.resume();
                }
                break;
        }
    }

    // 暂停队列处理
    pause() {
        if (!this.paused) {
            this.paused = true;
            logTime('请求队列已暂停处理');
        }
    }

    // 恢复队列处理
    resume() {
        if (this.paused) {
            this.paused = false;
            logTime('请求队列已恢复处理');
            // 恢复时检查是否有待处理的请求
            if (this.queue.length > 0 && !this.processing) {
                this.processQueue();
            }
        }
    }

    // 检查是否分片处于健康状态
    isAllShardsHealthy() {
        if (this.shardStatus.size === 0) {
            return true;
        }

        // 检查所有分片是否都处于健康状态
        for (const [_, status] of this.shardStatus) {
            if (status !== 'ready' && status !== 'resumed') {
                return false;
            }
        }
        return true;
    }

    async add(task, priority = 0) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                task,
                priority,
                resolve,
                reject,
                timestamp: Date.now(),
                retries: 0,
                originalPriority: priority // 保存原始优先级
            };

            // 动态提升等待过久的任务优先级
            this.adjustQueuePriorities();
            
            // 根据优先级插入队列
            const index = this.queue.findIndex(item => item.priority < priority);
            if (index === -1) {
                this.queue.push(queueItem);
            } else {
                this.queue.splice(index, 0, queueItem);
            }

            this.process();
        });
    }

    adjustQueuePriorities() {
        const now = Date.now();
        this.queue.forEach(item => {
            const waitTime = now - item.timestamp;
            if (waitTime > this.maxWaitTime) {
                // 等待时间过长的任务逐步提升优先级
                const priorityIncrease = Math.floor(waitTime / this.maxWaitTime);
                item.priority = Math.min(item.originalPriority + priorityIncrease, 3);
            }
        });
    }

    async process() {
        if (this.processing || this.paused) return;
        this.processing = true;

        try {
            while (this.queue.length > 0 && this.currentProcessing < this.maxConcurrent && !this.paused) {
                const item = this.queue.shift();
                this.currentProcessing++;

                this.executeTask(item).catch(error => {
                    logTime(`队列处理错误: ${error.message}`, true);
                });
            }
        } finally {
            this.processing = false;
            if (this.queue.length > 0 && !this.paused) {
                setImmediate(() => this.process());
            }
        }
    }

    async executeTask(item) {
        const { task, resolve, reject, timestamp } = item;
        const waitTime = Date.now() - timestamp;

        try {
            const result = await task();
            this.stats.processed++;
            resolve(result);
        } catch (error) {
            if (item.retries < this.maxRetries) {
                item.retries++;
                this.stats.retried++;
                this.queue.unshift(item); // 重新加入队列头部
                logTime(`任务重试 (${item.retries}/${this.maxRetries}): ${error.message}`);
            } else {
                this.stats.failed++;
                reject(error);
                logTime(`任务最终失败，等待时间: ${waitTime}ms，错误: ${error.message}`, true);
            }
        } finally {
            this.currentProcessing--;
            await new Promise(r => setTimeout(r, 50));
        }
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            currentProcessing: this.currentProcessing,
            averageWaitTime: this.queue.length > 0 
                ? this.queue.reduce((acc, item) => acc + (Date.now() - item.timestamp), 0) / this.queue.length 
                : 0
        };
    }
}

/**
 * 批量处理器
 * 用于控制批量操作的并发和延迟
 */
export class BatchProcessor {
    constructor() {
        // 不同任务类型的批处理配置
        this.configs = {
            // 子区检查 - 较大批次，较短延迟
            threadCheck: {
                batchSize: 30,
                delayMs: 100
            },
            // 子区分析 - 大批次，较短延迟
            threadAnalysis: {
                batchSize: 40,
                delayMs: 100
            },
            // 消息历史 - 中等批次，较长延迟
            messageHistory: {
                batchSize: 10,
                delayMs: 300
            },
            // 成员移除 - 小批次，较长延迟
            memberRemove: {
                batchSize: 5,
                delayMs: 500
            },
            // 默认配置
            default: {
                batchSize: 10,
                delayMs: 200
            }
        };
    }

    async processBatch(items, processor, progressCallback = null, taskType = 'default') {
        const config = this.configs[taskType] || this.configs.default;
        const results = [];
        const totalItems = items.length;

        for (let i = 0; i < items.length; i += config.batchSize) {
            const batch = items.slice(i, i + config.batchSize);
            const batchResults = await Promise.all(
                batch.map(item => processor(item))
            );
            
            results.push(...batchResults);

            // 调用进度回调
            if (progressCallback) {
                const progress = Math.min(100, ((i + batch.length) / totalItems) * 100);
                await progressCallback(progress, i + batch.length, totalItems);
            }

            // 添加延迟，除非是最后一批
            if (i + config.batchSize < items.length) {
                await new Promise(r => setTimeout(r, config.delayMs));
            }
        }

        return results;
    }
}

/**
 * 速率限制器
 * 用于控制请求频率
 */
export class RateLimiter {
    constructor(maxRequests = 50, timeWindowMs = 1000) {
        this.maxRequests = maxRequests;
        this.timeWindowMs = timeWindowMs;
        this.requests = [];
    }

    async acquire() {
        const now = Date.now();
        // 清理过期的请求记录
        this.requests = this.requests.filter(time => now - time < this.timeWindowMs);
        
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = this.timeWindowMs - (now - oldestRequest);
            await new Promise(r => setTimeout(r, waitTime));
            return this.acquire(); // 重新尝试
        }
        
        this.requests.push(now);
    }

    async withRateLimit(fn) {
        await this.acquire();
        return fn();
    }
}

// 创建单例实例
export const globalRequestQueue = new RequestQueue();
export const globalRateLimiter = new RateLimiter(40, 1000); // 每秒最多40个请求
export const globalBatchProcessor = new BatchProcessor(); 