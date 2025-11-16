import { globalLockManager } from './lockManager.js';
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
        this.maxConcurrent = 3;
        this.currentProcessing = 0;
        this.stats = {
            processed: 0,
            failed: 0,
        };

        // 活动任务跟踪（用于进度通知）
        this.activeTasks = new Map();
        this.taskTimeout = 900000; // 任务超时时间：15分钟
        this.lastProcessTime = Date.now();
        this.healthCheckInterval = setInterval(() => this.healthCheck(), 60000); // 1分钟
    }

    // 健康检查
    async healthCheck() {
        const now = Date.now();
        // 格式化最后处理时间
        const lastProcessTimeStr = new Date(this.lastProcessTime).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        // logTime(`队列长度: ${this.queue.length}, 最后处理时间: ${lastProcessTimeStr}`);

        // 如果队列有任务但超过3分钟没有处理，可能出现了死锁
        if (this.queue.length > 0 && now - this.lastProcessTime > 180000) {
            logTime('检测到队列可能死锁，正在重置状态...', true);
            this.currentProcessing = 0;
            this.process().catch(error => {
                logTime(`队列处理出错: ${error.message}`, true);
            });
        }
    }

    // 添加任务到队列
    async add(task, priority = 0) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                task: async () => {
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('任务执行超时')), this.taskTimeout);
                    });
                    return await Promise.race([task(), timeoutPromise]);
                },
                priority,
                resolve,
                reject,
                timestamp: Date.now(),
            };

            // 根据优先级插入队列
            const index = this.queue.findIndex(item => item.priority < priority);
            if (index === -1) {
                this.queue.push(queueItem);
            } else {
                this.queue.splice(index, 0, queueItem);
            }

            // 尝试处理队列
            this.process().catch(error => {
                logTime(`队列处理出错: ${error.message}`, true);
            });
        });
    }

    /**
     * 添加带通知的后台任务
     * @param {Object} options - 任务选项
     * @param {Function} options.task - 要执行的任务函数
     * @param {string} options.taskId - 任务唯一标识
     * @param {string} options.taskName - 任务名称
     * @param {Object} options.notifyTarget - 通知目标 {channel, user}
     * @param {Function} options.progressCallback - 进度回调函数
     * @param {number} options.priority - 任务优先级
     * @param {string} options.threadId - 子区ID（用于锁）
     * @param {string} options.guildId - 服务器ID（用于锁）
     * @returns {Promise} 任务承诺
     */
    async addBackgroundTask({
        task,
        taskId,
        taskName = '后台任务',
        notifyTarget,
        progressCallback,
        priority = 1,
        threadId,
        guildId
    }) {
        return new Promise((resolve, reject) => {
            const taskInfo = {
                taskId,
                taskName,
                notifyTarget,
                progressCallback,
                threadId,
                guildId,
                startTime: null,
                status: 'queued'
            };

            // 存储任务信息
            this.activeTasks.set(taskId, taskInfo);

            const queueItem = {
                task: async () => {
                    try {
                        // 自动等待并获取锁
                        if (threadId) {
                            // 发送等待通知
                            if (notifyTarget && globalLockManager.isThreadLocked(threadId)) {
                                await this.sendWaitingNotification(taskInfo, 'thread');
                            }

                            const acquired = await globalLockManager.waitAndAcquireThreadLock(threadId, taskName);
                            if (!acquired) {
                                throw new Error(`获取子区锁超时: ${threadId}`);
                            }
                        }

                        if (guildId) {
                            // 发送等待通知
                            if (notifyTarget && globalLockManager.isGuildLocked(guildId)) {
                                await this.sendWaitingNotification(taskInfo, 'guild');
                            }

                            const acquired = await globalLockManager.waitAndAcquireGuildLock(guildId, taskName);
                            if (!acquired) {
                                // 如果已经获取了子区锁，需要释放
                                if (threadId) {
                                    globalLockManager.releaseThreadLock(threadId, '获取服务器锁失败');
                                }
                                throw new Error(`获取服务器锁超时: ${guildId}`);
                            }
                        }

                        // 更新任务状态
                        taskInfo.status = 'running';
                        taskInfo.startTime = Date.now();

                        // 发送开始通知
                        if (notifyTarget) {
                            await this.sendTaskStartNotification(taskInfo);
                        }

                        // 执行任务
                        const result = await task();

                        // 任务完成
                        taskInfo.status = 'completed';

                        // 删除进度通知消息
                        if (taskInfo.notificationMessage) {
                            try {
                                await taskInfo.notificationMessage.delete();
                            } catch (error) {
                                logTime(`删除任务进度消息失败 (${taskId}): ${error.message}`, true);
                            }
                        }

                        return result;
                    } catch (error) {
                        taskInfo.status = 'failed';
                        taskInfo.error = error.message;

                        // 如果任务失败，也删除进度通知消息
                        if (taskInfo.notificationMessage) {
                            try {
                                await taskInfo.notificationMessage.delete();
                            } catch (deleteError) {
                                logTime(`删除失败任务进度消息失败 (${taskId}): ${deleteError.message}`, true);
                            }
                        }

                        throw error;
                    } finally {
                        // 释放锁
                        if (threadId) {
                            globalLockManager.releaseThreadLock(threadId, '任务完成');
                        }
                        if (guildId) {
                            globalLockManager.releaseGuildLock(guildId, '任务完成');
                        }

                        // 清理任务信息
                        this.activeTasks.delete(taskId);
                    }
                },
                priority,
                resolve,
                reject,
                timestamp: Date.now(),
                taskId
            };

            // 根据优先级插入队列
            const index = this.queue.findIndex(item => item.priority < priority);
            if (index === -1) {
                this.queue.push(queueItem);
            } else {
                this.queue.splice(index, 0, queueItem);
            }

            // 尝试处理队列
            this.process().catch(error => {
                logTime(`队列处理出错: ${error.message}`, true);
            });
        });
    }

    /**
     * 发送等待通知
     * @private
     */
    async sendWaitingNotification(taskInfo, lockType) {
        const { notifyTarget, taskName, taskId } = taskInfo;
        if (!notifyTarget?.channel || !notifyTarget?.user) return;

        const lockTypeText = lockType === 'thread' ? '子区' : '服务器';

        try {
            const message = await notifyTarget.channel.send({
                content: `<@${notifyTarget.user.id}>`,
                embeds: [{
                    color: 0xffaa00,
                    title: '⏳ 任务排队等待中',
                    description: `**${taskName}** 正在等待其他任务完成...`,
                    fields: [
                        { name: '任务ID', value: taskId, inline: true },
                        { name: '等待原因', value: `${lockTypeText}正在执行其他清理任务`, inline: true },
                        { name: '状态', value: '🔄 自动排队中，无需手动重试', inline: false }
                    ],
                    timestamp: new Date()
                }]
            });

            // 存储消息引用用于后续更新
            taskInfo.notificationMessage = message;
        } catch (error) {
            logTime(`发送等待通知失败: ${error.message}`, true);
        }
    }

    /**
     * 发送任务开始通知
     * @private
     */
    async sendTaskStartNotification(taskInfo) {
        const { notifyTarget, taskName, taskId } = taskInfo;
        if (!notifyTarget?.channel || !notifyTarget?.user) return;

        try {
            // 如果已经有通知消息，则编辑它；否则创建新的
            if (taskInfo.notificationMessage) {
                const embed = {
                    color: 0x00ff00,
                    title: '🚀 任务已开始',
                    description: `**${taskName}** 正在执行中...`,
                    fields: [
                        { name: '任务ID', value: taskId, inline: true },
                        { name: '开始时间', value: new Date().toLocaleString('zh-CN'), inline: true },
                        { name: '进度', value: '⏳ 准备中...', inline: false }
                    ],
                    timestamp: new Date()
                };

                await taskInfo.notificationMessage.edit({
                    embeds: [embed]
                });
            } else {
                const message = await notifyTarget.channel.send({
                    content: `<@${notifyTarget.user.id}>`,
                    embeds: [{
                        color: 0x00ff00,
                        title: '🚀 任务已开始',
                        description: `**${taskName}** 正在执行中...`,
                        fields: [
                            { name: '任务ID', value: taskId, inline: true },
                            { name: '开始时间', value: new Date().toLocaleString('zh-CN'), inline: true },
                            { name: '进度', value: '⏳ 准备中...', inline: false }
                        ],
                        timestamp: new Date()
                    }]
                });

                // 存储消息引用用于更新进度
                taskInfo.notificationMessage = message;
            }
        } catch (error) {
            logTime(`发送任务开始通知失败: ${error.message}`, true);
        }
    }

    // 处理队列中的任务
    async process() {
        // 更新最后处理时间
        this.lastProcessTime = Date.now();

        // 如果没有可用槽位，直接返回
        if (this.currentProcessing >= this.maxConcurrent) {
            return;
        }

        // 如果队列为空，直接返回
        if (this.queue.length === 0) {
            return;
        }

        // 获取可以处理的任务数量
        const availableSlots = this.maxConcurrent - this.currentProcessing;
        const tasksToProcess = Math.min(availableSlots, this.queue.length);

        if (tasksToProcess === 0) {
            return;
        }

        // 获取要处理的任务
        const tasks = this.queue.splice(0, tasksToProcess);

        // 并发处理任务
        const processPromises = tasks.map(async item => {
            this.currentProcessing++;
            try {
                const result = await item.task();
                this.stats.processed++;
                item.resolve(result);
                return result;
            } catch (error) {
                this.stats.failed++;
                item.reject(error);
                throw error;
            } finally {
                this.currentProcessing--;
                // 使用 setTimeout 来避免递归调用导致的栈溢出
                setTimeout(() => {
                    this.process().catch(error => {
                        logTime(`队列处理出错: ${error.message}`, true);
                    });
                }, 0);
            }
        });

        // 等待所有Promise完成
        await Promise.all(processPromises.map(p => p.catch(e => e)));
    }

    /**
     * 更新任务进度
     * @param {string} taskId - 任务ID
     * @param {string} progressText - 进度文本
     * @param {number} [percentage] - 进度百分比（0-100）
     */
    async updateTaskProgress(taskId, progressText, percentage) {
        const taskInfo = this.activeTasks.get(taskId);
        if (!taskInfo || !taskInfo.notificationMessage) return;

        try {
            const progressField = {
                name: '进度',
                value: percentage !== undefined
                    ? `${progressText} (${percentage.toFixed(1)}%)`
                    : progressText,
                inline: false
            };

            const embed = taskInfo.notificationMessage.embeds[0];
            const newEmbed = {
                ...embed,
                fields: [
                    ...embed.fields.slice(0, 2), // 保留任务ID和开始时间
                    progressField
                ],
                timestamp: new Date()
            };

            await taskInfo.notificationMessage.edit({
                embeds: [newEmbed]
            });
        } catch (error) {
            logTime(`更新任务进度失败 (${taskId}): ${error.message}`, true);
        }
    }

    // 清理请求队列
    async cleanup() {
        clearInterval(this.healthCheckInterval);

        if (this.queue.length > 0) {
            logTime(`[请求队列] 强制清理 ${this.queue.length} 个队列任务`);
            for (const item of this.queue) {
                item.reject(new Error('队列被强制清理'));
            }
            this.queue = [];
        }

        // 清理活动任务
        this.activeTasks.clear();

        this.currentProcessing = 0;
        this.stats.failed += this.currentProcessing;
        this.lastProcessTime = Date.now();
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
                windowMs: 1050, // 预留50ms延迟
                requests: [],
                concurrency: 1,
            },
            // 成员相关操作（身份组变动等） - 1次/秒
            members: {
                maxRequests: 1,
                windowMs: 1050, // 预留50ms延迟
                requests: [],
                concurrency: 1,
            },
            // 获取子区成员 - 1次/秒
            threadMembers: {
                maxRequests: 5,
                windowMs: 550, // 预留50ms延迟
                requests: [],
                concurrency: 1,
            },
            // 删除相关操作 - 5次/5秒
            deletion: {
                maxRequests: 5,
                windowMs: 4800, // 压缩200ms加速
                requests: [],
                concurrency: 1,
            },
            // 其他操作 - 40次/秒
            default: {
                maxRequests: 40,
                windowMs: 1050, // 预留50ms延迟
                requests: [],
                concurrency: 10,
            },
        };

        // 全局限制 - 50次/秒
        this.globalLimit = {
            maxRequests: 50,
            windowMs: 1050, // 预留50ms延迟
            requests: [],
        };

        this.isInterrupted = false;
        this.lastRequestTime = null;
        this.requestTimeout = 30000; // 30秒超时
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
            case 'threadMembers':
                return this.routeLimits.threadMembers;
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

    // 添加中断方法
    interrupt() {
        this.isInterrupted = true;
    }

    // 重置中断状态
    reset() {
        this.isInterrupted = false;
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
        this.reset();
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

        // 并发组处理批次
        for (let i = 0; i < batches.length; i += limiter.concurrency) {
            if (this.isInterrupted) {
                logTime(`批处理在组 ${i}/${batches.length} 处提前结束`);
                return results;
            }

            const currentBatches = batches.slice(i, i + limiter.concurrency);
            await Promise.all(
                currentBatches.map(async (batch, groupIndex) => {
                    const batchIndex = i + groupIndex;
                    for (const item of batch) {
                        if (this.isInterrupted) {
                            logTime(`批处理在组 ${i} 批次 ${groupIndex} 处跳出`);
                            return;
                        }

                        await this.waitForRateLimit(limiter);

                        try {
                            this.lastRequestTime = Date.now();
                            results[batchIndex * batchSize + batch.indexOf(item)] = await processor(item);
                        } catch (error) {
                            results[batchIndex * batchSize + batch.indexOf(item)] = null;

                            // 检查是否是token失效
                            if (error.code === 40001 || error.code === 50014 || error.message.includes('Invalid Webhook Token')) {
                                logTime('检测到Token失效，暂停处理');
                                // 等待30秒后再继续，给token重连留出时间
                                await delay(30000);
                                continue;
                            }

                            if (
                                error.code === 'ECONNRESET' ||
                                error.code === 'ETIMEDOUT' ||
                                error.code === 'EPIPE' ||
                                error.code === 'ENOTFOUND' ||
                                error.code === 'ECONNREFUSED' ||
                                error.name === 'DiscordAPIError' ||
                                error.name === 'HTTPError' ||
                                Date.now() - this.lastRequestTime > this.requestTimeout
                            ) {
                                logTime(
                                    `批处理因错误中断: ${error.name}${error.code ? ` (${error.code})` : ''} - ${
                                        error.message
                                    }`,
                                );
                                this.interrupt();
                                return;
                            }
                            logTime(
                                `批处理遇到未处理的错误: ${error.name}${error.code ? ` (${error.code})` : ''} - ${
                                    error.message
                                }`,
                                true,
                            );
                            throw error;
                        }

                        processedCount++;
                        if (progressCallback) {
                            const progress = Math.min(100, (processedCount / totalItems) * 100);
                            await progressCallback(progress, processedCount, totalItems);
                        }

                        await delay(5);
                    }
                }),
            );
        }

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
