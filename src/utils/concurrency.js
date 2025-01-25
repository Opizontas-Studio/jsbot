import { WebSocketShardStatus } from 'discord.js';
import { logTime } from './logger.js';

// 延迟函数
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 全局请求队列
 * 用于控制和序列化异步请求
 */
export class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxConcurrent = 5;
        this.currentProcessing = 0;
        this.maxRetries = 2; // 重试次数
        this.stats = {
            processed: 0,
            failed: 0,
            retried: 0,
        };
        this.paused = false;
        this.shardStatus = new Map();
        this.validStates = new Set([
            WebSocketShardStatus.Idle,
            WebSocketShardStatus.Connecting,
            WebSocketShardStatus.Resuming,
            WebSocketShardStatus.Ready,
        ]);
    }

    // 设置分片状态
    setShardStatus(status) {
        if (!this.validStates.has(status)) {
            throw new Error(`无效的分片状态: ${status}`);
        }

        const oldStatus = this.shardStatus.get(0);
        if (oldStatus === status) {
            return;
        }

        this.shardStatus.set(0, status);

        // 根据状态执行相应操作
        switch (status) {
            case WebSocketShardStatus.Idle:
                this.pause();
                break;
            case WebSocketShardStatus.Ready:
                this.resume();
                break;
            case WebSocketShardStatus.Connecting:
            case WebSocketShardStatus.Resuming:
                // 短暂暂停后自动恢复
                this.pause();
                setTimeout(() => {
                    if (this.shardStatus.get(0) === status) {
                        this.resume();
                    }
                }, 2000);
                break;
        }
    }

    // 添加任务到队列
    async add(task, priority = 0) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                task,
                priority,
                resolve,
                reject,
                retries: 0,
            };

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

    // 处理队列中的任务
    async process() {
        if (this.paused) {
            return;
        }

        // 检查是否可以处理更多任务
        const availableSlots = this.maxConcurrent - this.currentProcessing;
        if (availableSlots <= 0) {
            return;
        }

        // 获取可以处理的任务数量
        const tasksToProcess = Math.min(availableSlots, this.queue.length);
        if (tasksToProcess === 0) {
            return;
        }

        // 对队列按优先级排序
        this.queue.sort((a, b) => b.priority - a.priority);

        // 并发处理多个任务
        const tasks = this.queue.splice(0, tasksToProcess);
        const processPromises = tasks.map(async item => {
            this.currentProcessing++;

            try {
                const result = await item.task();
                this.stats.processed++;
                item.resolve(result);
            } catch (error) {
                if (item.retries < this.maxRetries) {
                    item.retries++;
                    this.stats.retried++;
                    // 将重试任务添加到队列中，保持原优先级
                    const index = this.queue.findIndex(qItem => qItem.priority < item.priority);
                    if (index === -1) {
                        this.queue.push(item);
                    } else {
                        this.queue.splice(index, 0, item);
                    }
                    logTime(`任务重试 (${item.retries}/${this.maxRetries}): ${error.message}`);
                } else {
                    this.stats.failed++;
                    item.reject(error);
                }
            } finally {
                this.currentProcessing--;
                await delay(50);
            }
        });

        // 等待所有任务完成
        await Promise.all(processPromises);

        // 如果队列中还有任务，继续处理
        if (this.queue.length > 0 && !this.paused) {
            await delay(0);
            this.process();
        }
    }

    // 暂停请求队列
    pause() {
        if (!this.paused) {
            this.paused = true;
            logTime('请求队列已暂停');
        }
    }

    // 恢复请求队列
    resume() {
        if (this.paused) {
            this.paused = false;
            logTime('请求队列已恢复');
            if (this.queue.length > 0) {
                this.process();
            }
        }
    }

    // 获取统计信息
    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            currentProcessing: this.currentProcessing,
        };
    }

    // 清理请求队列
    async cleanup() {
        this.pause();

        if (this.currentProcessing > 0) {
            logTime(`等待 ${this.currentProcessing} 个正在处理的任务完成...`);
            while (this.currentProcessing > 0) {
                await delay(100);
            }
        }

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
}

/**
 * Discord API 速率限制处理器
 * 用于控制API请求的发送速率，避免触发限制
 */
class RateLimitedBatchProcessor {
    constructor() {
        // 路由限制配置
        this.routeLimits = {
            // 消息相关操作 - 5次/秒
            messages: {
                maxRequests: 5,
                windowMs: 1000,
                requests: [],
                concurrency: 3, // 允许的并发数
            },
            // 成员相关操作 - 5次/秒
            members: {
                maxRequests: 5,
                windowMs: 1000,
                requests: [],
                concurrency: 3, // 允许的并发数
            },
            // 其他操作 - 30次/秒
            default: {
                maxRequests: 40,
                windowMs: 1000,
                requests: [],
                concurrency: 10, // 允许的并发数
            },
        };

        // 全局限制 - 50次/秒
        this.globalLimit = {
            maxRequests: 50,
            windowMs: 1000,
            requests: [],
        };
    }

    /**
     * 获取操作类型对应的限制器
     * @private
     */
    getLimiter(taskType) {
        switch (taskType) {
            case 'messageHistory':
                return this.routeLimits.messages;
            case 'memberRemove':
                return this.routeLimits.members;
            default:
                return this.routeLimits.default;
        }
    }

    /**
     * 检查是否可以执行请求并等待合适的时机
     * @private
     */
    async waitForRateLimit(limiter) {
        while (true) {
            const now = Date.now();

            // 清理过期的请求记录
            limiter.requests = limiter.requests.filter(time => now - time < limiter.windowMs);
            this.globalLimit.requests = this.globalLimit.requests.filter(
                time => now - time < this.globalLimit.windowMs,
            );

            // 如果在限制范围内，记录并继续
            if (
                limiter.requests.length < limiter.maxRequests &&
                this.globalLimit.requests.length < this.globalLimit.maxRequests
            ) {
                limiter.requests.push(now);
                this.globalLimit.requests.push(now);
                return;
            }

            // 计算需要等待的时间
            const oldestRequest = Math.min(...limiter.requests, ...this.globalLimit.requests);
            const waitTime = oldestRequest + limiter.windowMs - now;
            await delay(waitTime);
        }
    }

    /**
     * 处理批量任务
     * @param {Array} items - 要处理的项目数组
     * @param {Function} processor - 处理函数
     * @param {Function} progressCallback - 进度回调函数
     * @param {string} taskType - 任务类型
     * @returns {Promise<Array>} 处理结果数组
     */
    async processBatch(items, processor, progressCallback = null, taskType = 'default') {
        const limiter = this.getLimiter(taskType);
        const results = new Array(items.length);
        let processedCount = 0;
        const totalItems = items.length;

        // 创建处理分组
        const batchSize = Math.min(50, Math.ceil(items.length / limiter.concurrency));
        const batches = [];

        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }

        // 并发处理每个批次
        await Promise.all(
            batches.map(async (batch, batchIndex) => {
                for (const item of batch) {
                    const index = batchIndex * batchSize + batch.indexOf(item);

                    // 等待速率限制
                    await this.waitForRateLimit(limiter);

                    // 执行任务
                    try {
                        results[index] = await processor(item);
                    } catch (error) {
                        results[index] = null;
                        throw error;
                    }

                    // 更新进度
                    processedCount++;
                    if (progressCallback) {
                        const progress = Math.min(100, (processedCount / totalItems) * 100);
                        await progressCallback(progress, processedCount, totalItems);
                    }

                    // 添加小延迟避免请求过于密集
                    await delay(10);
                }
            }),
        );

        return results;
    }
}

/**
 * 生成进度报告
 * @param {number} current - 当前进度
 * @param {number} total - 总数
 * @param {Object} [options] - 可选配置
 * @param {string} [options.prefix=''] - 前缀文本
 * @param {string} [options.suffix=''] - 后缀文本
 * @param {boolean} [options.showPercentage=true] - 是否显示百分比
 * @param {boolean} [options.showNumbers=true] - 是否显示数字
 * @param {string} [options.progressChar='⏳'] - 进度指示符
 * @returns {string} 格式化的进度信息
 */
export const generateProgressReport = (current, total, options = {}) => {
    const { prefix = '', suffix = '', showPercentage = true, showNumbers = true, progressChar = '⏳' } = options;

    const progress = ((current / total) * 100).toFixed(1);
    const parts = [];

    if (prefix) {
        parts.push(prefix);
    }
    if (progressChar) {
        parts.push(progressChar);
    }
    if (showNumbers) {
        parts.push(`${current}/${total}`);
    }
    if (showPercentage) {
        parts.push(`(${progress}%)`);
    }
    if (suffix) {
        parts.push(suffix);
    }

    return parts.join(' ');
};

// 创建单例实例
export const globalRequestQueue = new RequestQueue();
export const globalBatchProcessor = new RateLimitedBatchProcessor();
