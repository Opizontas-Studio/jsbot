const { logTime } = require('./helper');

/**
 * 全局请求队列
 * 用于控制和序列化异步请求
 */
class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxConcurrent = 5; // 添加最大并发数限制
        this.currentProcessing = 0;
    }

    async add(task, priority = 0) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                task,
                priority,
                resolve,
                reject,
                timestamp: Date.now()
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

    async process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0 && this.currentProcessing < this.maxConcurrent) {
            const { task, resolve, reject, timestamp } = this.queue.shift();
            const waitTime = Date.now() - timestamp;
            
            this.currentProcessing++;

            try {
                const result = await task();
                resolve(result);
            } catch (error) {
                reject(error);
                logTime(`请求处理失败，等待时间: ${waitTime}ms，错误: ${error.message}`, true);
            } finally {
                this.currentProcessing--;
            }

            // 增加延迟以避免API限制
            await new Promise(r => setTimeout(r, 100));
        }

        this.processing = this.currentProcessing > 0;
        if (this.queue.length > 0) {
            this.process();
        }
    }
}

/**
 * 批量处理器
 * 用于控制批量操作的并发和延迟
 */
class BatchProcessor {
    constructor(batchSize = 10, delayMs = 100) {
        this.batchSize = batchSize;
        this.delayMs = delayMs;
    }

    async processBatch(items, processor, progressCallback = null) {
        const results = [];
        const totalItems = items.length;

        for (let i = 0; i < items.length; i += this.batchSize) {
            const batch = items.slice(i, i + this.batchSize);
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
            if (i + this.batchSize < items.length) {
                await new Promise(r => setTimeout(r, this.delayMs));
            }
        }

        return results;
    }
}

/**
 * 速率限制器
 * 用于控制请求频率
 */
class RateLimiter {
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
const globalRequestQueue = new RequestQueue();
const globalRateLimiter = new RateLimiter(10, 1000); // 每秒最多10个请求
const globalBatchProcessor = new BatchProcessor(5, 200); // 每批5个请求，间隔200ms

module.exports = {
    RequestQueue,
    BatchProcessor,
    RateLimiter,
    globalRequestQueue,
    globalRateLimiter,
    globalBatchProcessor
}; 