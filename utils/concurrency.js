import { logTime } from './logger.js';
import { delay } from './helper.js';

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
            retried: 0
        };
        this.paused = false;
        this.shardStatus = new Map();
        this.validStates = new Set(['ready', 'disconnected', 'reconnecting', 'error', 'resumed']);
    }

    // 设置分片状态
    setShardStatus(status) {
        if (!this.validStates.has(status)) {
            throw new Error(`无效的分片状态: ${status}`);
        }

        const oldStatus = this.shardStatus.get(0);
        if (oldStatus === status) return;
        
        this.shardStatus.set(0, status);
        
        // 只在致命错误时暂停队列
        if (status === 'error') {
            this.pause();
        } else if (status === 'ready' || status === 'resumed' || status === 'reconnecting') {
            this.resume();
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
                retries: 0
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
        if (this.paused) return;

        // 检查是否可以处理更多任务
        const availableSlots = this.maxConcurrent - this.currentProcessing;
        if (availableSlots <= 0) return;

        // 获取可以处理的任务数量
        const tasksToProcess = Math.min(availableSlots, this.queue.length);
        if (tasksToProcess === 0) return;

        // 对队列按优先级排序
        this.queue.sort((a, b) => b.priority - a.priority);

        // 并发处理多个任务
        const tasks = this.queue.splice(0, tasksToProcess);
        const processPromises = tasks.map(async (item) => {
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
            currentProcessing: this.currentProcessing
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
 * 批量处理器
 * 用于控制批量操作的并发和延迟
 */
export class BatchProcessor {
    constructor() {
        // 不同任务类型的批处理配置
        this.configs = {
            // 子区检查 - 较大批次，较短延迟
            threadCheck: {
                batchSize: 45,
                delayMs: 100
            },
            // 子区分析 - 大批次，较短延迟
            threadAnalysis: {
                batchSize: 25,
                delayMs: 500
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

// 创建单例实例
export const globalRequestQueue = new RequestQueue();
export const globalBatchProcessor = new BatchProcessor(); 