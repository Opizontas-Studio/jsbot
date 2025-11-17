import PQueue from 'p-queue';

/**
 * 队列管理器
 * 基于 p-queue 库，提供任务并发控制和优先级调度
 */
export class QueueManager {
    /**
     * @param {Object} config - 配置选项
     * @param {number} [config.concurrency] - 最大并发数，默认3
     * @param {number} [config.timeout] - 任务超时时间（毫秒），默认15分钟
     * @param {Object} [config.priorities] - 优先级配置
     */
    constructor(config = {}) {
        this.config = {
            concurrency: config.concurrency ?? 3, // 默认3
            timeout: config.timeout ?? 900000, // 默认15分钟
            priorities: config.priorities ?? {
                high: 10,
                normal: 5,
                low: 1
            }
        };

        this.queue = new PQueue({
            concurrency: this.config.concurrency,
            timeout: this.config.timeout,
            throwOnTimeout: true
        });

        this.logger = null; // 将由容器注入
        this.lockManager = null; // 将由容器注入

        // 统计信息
        this.stats = {
            processed: 0,
            failed: 0,
            timedOut: 0,
            totalWaitTime: 0
        };

        // 任务跟踪（用于进度通知）
        this.activeTasks = new Map();

        // 监听队列事件
        this._setupEventListeners();
    }

    /**
     * 设置依赖（容器注入后调用）
     * @param {Object} logger - 日志器实例
     * @param {Object} lockManager - 锁管理器实例
     */
    setDependencies(logger, lockManager = null) {
        this.logger = logger;
        this.lockManager = lockManager;
    }

    /**
     * 设置事件监听器
     * @private
     */
    _setupEventListeners() {
        this.queue.on('active', () => {
            this.logger?.debug(`[队列管理] 任务开始执行 - 队列: ${this.queue.size}, 进行中: ${this.queue.pending}`);
        });

        this.queue.on('idle', () => {
            this.logger?.debug(`[队列管理] 队列空闲`);
        });

        this.queue.on('error', (error) => {
            this.logger?.error('[队列管理] 队列错误:', error);
        });
    }

    /**
     * 添加任务到队列
     * @param {Function} task - 任务函数
     * @param {Object} [options] - 选项
     * @param {string|number} [options.priority='normal'] - 优先级 (high/normal/low 或数字)
     * @param {number} [options.timeout] - 自定义超时时间
     * @param {string} [options.taskId] - 任务ID（可选，用于跟踪）
     * @param {string} [options.taskName] - 任务名称（用于日志）
     * @returns {Promise<any>} 任务返回值
     */
    async add(task, options = {}) {
        const startTime = Date.now();
        const taskId = options.taskId || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const taskName = options.taskName || '未命名任务';

        // 解析优先级
        let priority = options.priority || 'normal';
        if (typeof priority === 'string') {
            priority = this.config.priorities[priority] || this.config.priorities.normal;
        }

        try {
            this.logger?.debug(`[队列管理] 添加任务: ${taskName} (ID: ${taskId}, 优先级: ${priority})`);

            const result = await this.queue.add(
                async () => {
                    const waitTime = Date.now() - startTime;
                    this.stats.totalWaitTime += waitTime;

                    if (waitTime > 5000) {
                        this.logger?.info(`[队列管理] 任务开始: ${taskName} - 等待了 ${waitTime}ms`);
                    }

                    try {
                        return await task();
                    } catch (error) {
                        this.stats.failed++;
                        throw error;
                    }
                },
                {
                    priority,
                    timeout: options.timeout
                }
            );

            this.stats.processed++;
            return result;
        } catch (error) {
            if (error.name === 'TimeoutError') {
                this.stats.timedOut++;
                this.logger?.warn(`[队列管理] 任务超时: ${taskName} (ID: ${taskId})`);
                throw new Error(`任务执行超时: ${taskName}`);
            }
            throw error;
        }
    }

    /**
     * 添加带锁的任务
     * @param {Function} task - 任务函数
     * @param {Object} options - 选项
     * @param {string} options.lockResource - 锁资源类型
     * @param {string} options.lockId - 锁资源ID
     * @param {string} [options.lockOperation] - 锁操作名称
     * @param {string|number} [options.priority='normal'] - 优先级
     * @param {number} [options.timeout] - 自定义超时时间
     * @param {string} [options.taskId] - 任务ID
     * @param {string} [options.taskName] - 任务名称
     * @returns {Promise<any>} 任务返回值
     */
    async addWithLock(task, options) {
        if (!this.lockManager) {
            throw new Error('[队列管理] LockManager未注入，无法使用带锁任务');
        }

        const { lockResource, lockId, lockOperation, ...queueOptions } = options;

        return this.add(
            async () => {
                return this.lockManager.acquire(
                    lockResource,
                    lockId,
                    task,
                    { operation: lockOperation }
                );
            },
            queueOptions
        );
    }

    /**
     * 添加带通知的后台任务
     * @param {Object} options - 任务选项
     * @param {Function} options.task - 任务函数
     * @param {string} options.taskId - 任务唯一标识
     * @param {string} options.taskName - 任务名称
     * @param {Object} [options.notifyTarget] - 通知目标 {channel, user}
     * @param {Function} [options.progressCallback] - 进度回调函数
     * @param {string|number} [options.priority='low'] - 优先级
     * @param {string} [options.lockResource] - 锁资源类型（可选）
     * @param {string} [options.lockId] - 锁资源ID（可选）
     * @returns {Promise<any>} 任务返回值
     */
    async addBackgroundTask(options) {
        const {
            task,
            taskId,
            taskName = '后台任务',
            notifyTarget,
            progressCallback,
            priority = 'low',
            lockResource,
            lockId
        } = options;

        // 注册任务信息
        const taskInfo = {
            taskId,
            taskName,
            notifyTarget,
            progressCallback,
            lockResource,
            lockId,
            startTime: null,
            status: 'queued'
        };

        this.activeTasks.set(taskId, taskInfo);

        try {
            // 包装任务
            const wrappedTask = async () => {
                try {
                    // 发送等待通知（如果资源被锁定）
                    if (lockResource && lockId && this.lockManager?.isBusy(lockResource, lockId)) {
                        await this._sendWaitingNotification(taskInfo);
                    }

                    // 更新状态
                    taskInfo.status = 'running';
                    taskInfo.startTime = Date.now();

                    // 发送开始通知
                    if (notifyTarget) {
                        await this._sendTaskStartNotification(taskInfo);
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
                            this.logger?.warn(`[队列管理] 删除任务进度消息失败 (${taskId}):`, error);
                        }
                    }

                    return result;
                } catch (error) {
                    taskInfo.status = 'failed';
                    taskInfo.error = error.message;

                    // 删除进度通知消息
                    if (taskInfo.notificationMessage) {
                        try {
                            await taskInfo.notificationMessage.delete();
                        } catch (deleteError) {
                            this.logger?.warn(`[队列管理] 删除失败任务进度消息失败 (${taskId}):`, deleteError);
                        }
                    }

                    throw error;
                } finally {
                    // 清理任务信息
                    this.activeTasks.delete(taskId);
                }
            };

            // 添加任务（带锁或不带锁）
            if (lockResource && lockId) {
                return await this.addWithLock(wrappedTask, {
                    lockResource,
                    lockId,
                    lockOperation: taskName,
                    priority,
                    taskId,
                    taskName
                });
            } else {
                return await this.add(wrappedTask, {
                    priority,
                    taskId,
                    taskName
                });
            }
        } catch (error) {
            // 确保任务信息被清理
            this.activeTasks.delete(taskId);
            throw error;
        }
    }

    /**
     * 发送等待通知
     * @private
     */
    async _sendWaitingNotification(taskInfo) {
        const { notifyTarget, taskName, taskId, lockResource } = taskInfo;
        if (!notifyTarget?.channel || !notifyTarget?.user) return;

        const resourceText = lockResource || '资源';

        try {
            const message = await notifyTarget.channel.send({
                content: `<@${notifyTarget.user.id}>`,
                embeds: [{
                    color: 0xffaa00,
                    title: '⏳ 任务排队等待中',
                    description: `**${taskName}** 正在等待其他任务完成...`,
                    fields: [
                        { name: '任务ID', value: taskId, inline: true },
                        { name: '等待原因', value: `${resourceText}正在被其他任务占用`, inline: true },
                        { name: '状态', value: '🔄 自动排队中，无需手动重试', inline: false }
                    ],
                    timestamp: new Date().toISOString()
                }]
            });

            taskInfo.notificationMessage = message;
        } catch (error) {
            this.logger?.warn('[队列管理] 发送等待通知失败:', error);
        }
    }

    /**
     * 发送任务开始通知
     * @private
     */
    async _sendTaskStartNotification(taskInfo) {
        const { notifyTarget, taskName, taskId } = taskInfo;
        if (!notifyTarget?.channel || !notifyTarget?.user) return;

        try {
            const embed = {
                color: 0x00ff00,
                title: '🚀 任务已开始',
                description: `**${taskName}** 正在执行中...`,
                fields: [
                    { name: '任务ID', value: taskId, inline: true },
                    { name: '开始时间', value: new Date().toLocaleString('zh-CN'), inline: true },
                    { name: '进度', value: '⏳ 准备中...', inline: false }
                ],
                timestamp: new Date().toISOString()
            };

            if (taskInfo.notificationMessage) {
                await taskInfo.notificationMessage.edit({ embeds: [embed] });
            } else {
                const message = await notifyTarget.channel.send({
                    content: `<@${notifyTarget.user.id}>`,
                    embeds: [embed]
                });
                taskInfo.notificationMessage = message;
            }
        } catch (error) {
            this.logger?.warn('[队列管理] 发送任务开始通知失败:', error);
        }
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
                ...embed.toJSON(),
                fields: [
                    ...embed.fields.slice(0, 2), // 保留任务ID和开始时间
                    progressField
                ],
                timestamp: new Date().toISOString()
            };

            await taskInfo.notificationMessage.edit({ embeds: [newEmbed] });
        } catch (error) {
            this.logger?.warn(`[队列管理] 更新任务进度失败 (${taskId}):`, error);
        }
    }

    /**
     * 暂停队列
     */
    pause() {
        this.queue.pause();
        this.logger?.info('[队列管理] 队列已暂停');
    }

    /**
     * 恢复队列
     */
    resume() {
        this.queue.start();
        this.logger?.info('[队列管理] 队列已恢复');
    }

    /**
     * 清空队列
     */
    clear() {
        this.queue.clear();
        this.logger?.info('[队列管理] 队列已清空');
    }

    /**
     * 等待队列空闲
     * @returns {Promise<void>}
     */
    async onIdle() {
        return this.queue.onIdle();
    }

    /**
     * 获取队列状态
     * @returns {Object} 状态信息
     */
    getStatus() {
        return {
            size: this.queue.size, // 等待中的任务数
            pending: this.queue.pending, // 执行中的任务数
            isPaused: this.queue.isPaused,
            stats: { ...this.stats },
            activeTasks: Array.from(this.activeTasks.keys())
        };
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        const avgWaitTime = this.stats.processed > 0
            ? Math.round(this.stats.totalWaitTime / this.stats.processed)
            : 0;

        return {
            ...this.stats,
            avgWaitTime,
            successRate: this.stats.processed > 0
                ? ((this.stats.processed - this.stats.failed) / this.stats.processed * 100).toFixed(2) + '%'
                : 'N/A'
        };
    }

    /**
     * 清理资源（优雅关闭时调用）
     */
    async cleanup() {
        this.logger?.info('[队列管理] 开始清理资源');

        // 暂停接受新任务
        this.pause();

        // 等待所有任务完成
        const queueSize = this.queue.size;
        const pendingSize = this.queue.pending;

        if (queueSize > 0 || pendingSize > 0) {
            this.logger?.info(`[队列管理] 等待 ${pendingSize} 个任务完成，${queueSize} 个任务将被取消`);

            // 清空等待队列
            this.clear();

            // 等待执行中的任务完成（最多等待30秒）
            try {
                await Promise.race([
                    this.queue.onIdle(),
                    new Promise((resolve) => setTimeout(resolve, 30000))
                ]);
            } catch (error) {
                this.logger?.warn('[队列管理] 等待任务完成时出错:', error);
            }
        }

        // 清理活动任务
        this.activeTasks.clear();

        // 输出统计信息
        const stats = this.getStats();
        this.logger?.info('[队列管理] 最终统计:', stats);

        this.logger?.info('[队列管理] 资源清理完成');
    }
}

