import { logTime } from './helper.js';

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
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.queue.length > 0 && this.currentProcessing < this.maxConcurrent) {
                const item = this.queue.shift();
                this.currentProcessing++;

                this.executeTask(item).catch(error => {
                    logTime(`队列处理错误: ${error.message}`, true);
                });
            }
        } finally {
            this.processing = false;
            if (this.queue.length > 0) {
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
            await new Promise(r => setTimeout(r, 100));
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
                batchSize: 15,
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
export const globalRateLimiter = new RateLimiter(10, 1000); // 每秒最多10个请求
export const globalBatchProcessor = new BatchProcessor(); 