import schedule from 'node-schedule';

/**
 * 调度管理器
 * 基于 node-schedule 库，提供定时任务管理
 */
export class SchedulerManager {
    constructor() {
        this.jobs = new Map(); // 存储所有任务
        this.logger = null; // 将由容器注入

        // 统计信息
        this.stats = {
            totalJobs: 0,
            activeJobs: 0,
            completedExecutions: 0,
            failedExecutions: 0
        };
    }

    /**
     * 设置日志器（容器注入后调用）
     * @param {Object} logger - 日志器实例
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * 添加任务
     * @param {Object} options - 任务选项
     * @param {string} options.taskId - 任务唯一标识
     * @param {number} options.interval - 执行间隔（毫秒）
     * @param {Function} options.task - 要执行的任务函数
     * @param {boolean} [options.runImmediately=false] - 是否立即执行一次
     * @param {Date} [options.startAt] - 延迟到指定时间后开始
     * @param {string} [options.description] - 任务描述
     */
    addTask(options) {
        const {
            taskId,
            interval,
            task,
            runImmediately = false,
            startAt,
            description = taskId,
            replaceExisting = false
        } = options;

        if (this.jobs.has(taskId)) {
            if (!replaceExisting) {
                this.logger?.warn(`[调度管理] 任务 ${taskId} 已存在，跳过注册`);
                return;
            }
            this.cancelTask(taskId);
        }

        // 包装任务以添加错误处理和统计
        const wrappedTask = async () => {
            try {
                this.logger?.debug(`[调度管理] 执行任务: ${description}`);
                await task();
                this.stats.completedExecutions++;
            } catch (error) {
                this.stats.failedExecutions++;
                this.logger?.error(`[调度管理] 任务执行失败: ${description}`, error);
            }
        };

        // 计算开始时间
        const actualStartAt = startAt || (runImmediately ? new Date() : new Date(Date.now() + interval));

        // 创建定时器
        let timeoutId = null;
        let intervalId = null;

        // 首次执行
        const delay = actualStartAt.getTime() - Date.now();
        timeoutId = setTimeout(
            () => {
                wrappedTask(); // 首次执行

                // 设置定期执行
                intervalId = setInterval(wrappedTask, interval);

                // 更新任务信息
                const jobInfo = this.jobs.get(taskId);
                if (jobInfo) {
                    jobInfo.intervalId = intervalId;
                    jobInfo.timeoutId = null;
                }
            },
            Math.max(0, delay)
        );

        // 存储任务信息
        const jobInfo = {
            taskId,
            interval,
            task: wrappedTask,
            timeoutId,
            intervalId: null,
            description,
            createdAt: new Date(),
            nextRun: actualStartAt
        };

        this.jobs.set(taskId, jobInfo);
        this.stats.totalJobs++;
        this.stats.activeJobs++;

        this.logger?.info(
            `[调度管理] 注册定时任务: ${description} (间隔: ${interval}ms, 首次执行: ${actualStartAt.toLocaleString('zh-CN')})`
        );
    }

    /**
     * 添加每日任务
     * @param {Object} options - 任务选项
     * @param {string} options.taskId - 任务唯一标识
     * @param {number} options.hour - 执行小时（0-23）
     * @param {number} options.minute - 执行分钟（0-59）
     * @param {Function} options.task - 要执行的任务函数
     * @param {string} [options.description] - 任务描述
     */
    addDailyTask(options) {
        const { taskId, hour, minute, task, description = taskId, replaceExisting = false } = options;

        if (this.jobs.has(taskId)) {
            if (!replaceExisting) {
                this.logger?.warn(`[调度管理] 任务 ${taskId} 已存在，跳过注册`);
                return;
            }
            this.cancelTask(taskId);
        }

        // 创建规则：每天指定时间执行
        const rule = new schedule.RecurrenceRule();
        rule.hour = hour;
        rule.minute = minute;
        rule.second = 0;

        this._addScheduledTask(taskId, rule, task, description);
    }

    /**
     * 添加自定义规则任务
     * @param {Object} options - 任务选项
     * @param {string} options.taskId - 任务唯一标识
     * @param {string|Object} options.rule - Cron表达式或RecurrenceRule对象
     * @param {Function} options.task - 要执行的任务函数
     * @param {string} [options.description] - 任务描述
     */
    addCustomTask(options) {
        const { taskId, rule, task, description = taskId, replaceExisting = false } = options;

        if (this.jobs.has(taskId)) {
            if (!replaceExisting) {
                this.logger?.warn(`[调度管理] 任务 ${taskId} 已存在，跳过注册`);
                return;
            }
            this.cancelTask(taskId);
        }

        this._addScheduledTask(taskId, rule, task, description);
    }

    /**
     * 内部方法：添加调度任务
     * @private
     */
    _addScheduledTask(taskId, rule, task, description) {
        // 包装任务以添加错误处理和统计
        const wrappedTask = async () => {
            try {
                this.logger?.debug(`[调度管理] 执行任务: ${description}`);
                await task();
                this.stats.completedExecutions++;
            } catch (error) {
                this.stats.failedExecutions++;
                this.logger?.error(`[调度管理] 任务执行失败: ${description}`, error);
            }
        };

        // 创建调度任务
        const job = schedule.scheduleJob(rule, wrappedTask);

        // 存储任务信息
        const jobInfo = {
            taskId,
            job,
            rule,
            task: wrappedTask,
            description,
            createdAt: new Date(),
            nextRun: job.nextInvocation()
        };

        this.jobs.set(taskId, jobInfo);
        this.stats.totalJobs++;
        this.stats.activeJobs++;

        const nextRun = job.nextInvocation();
        this.logger?.info(
            `[调度管理] 注册调度任务: ${description} (下次执行: ${nextRun ? nextRun.toLocaleString('zh-CN') : 'N/A'})`
        );
    }

    /**
     * 取消任务
     * @param {string} taskId - 任务ID
     * @returns {boolean} 是否成功取消
     */
    cancelTask(taskId) {
        const jobInfo = this.jobs.get(taskId);
        if (!jobInfo) {
            this.logger?.warn(`[调度管理] 任务 ${taskId} 不存在`);
            return false;
        }

        // 取消定时器或调度任务
        if (jobInfo.timeoutId) {
            clearTimeout(jobInfo.timeoutId);
        }
        if (jobInfo.intervalId) {
            clearInterval(jobInfo.intervalId);
        }
        if (jobInfo.job) {
            jobInfo.job.cancel();
        }

        this.jobs.delete(taskId);
        this.stats.activeJobs--;

        this.logger?.info(`[调度管理] 取消任务: ${jobInfo.description}`);
        return true;
    }

    /**
     * 获取任务信息
     * @param {string} taskId - 任务ID
     * @returns {Object|null} 任务信息
     */
    getTask(taskId) {
        const jobInfo = this.jobs.get(taskId);
        if (!jobInfo) {
            return null;
        }

        return {
            taskId: jobInfo.taskId,
            description: jobInfo.description,
            createdAt: jobInfo.createdAt,
            nextRun: jobInfo.job ? jobInfo.job.nextInvocation() : jobInfo.nextRun
        };
    }

    /**
     * 获取所有任务
     * @returns {Array} 任务列表
     */
    getAllTasks() {
        return Array.from(this.jobs.values()).map(jobInfo => ({
            taskId: jobInfo.taskId,
            description: jobInfo.description,
            createdAt: jobInfo.createdAt,
            nextRun: jobInfo.job ? jobInfo.job.nextInvocation() : jobInfo.nextRun
        }));
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        return {
            ...this.stats,
            successRate:
                this.stats.completedExecutions + this.stats.failedExecutions > 0
                    ? (
                          (this.stats.completedExecutions /
                              (this.stats.completedExecutions + this.stats.failedExecutions)) *
                          100
                      ).toFixed(2) + '%'
                    : 'N/A'
        };
    }

    /**
     * 获取任务状态
     * @returns {Object} 状态信息
     */
    getStatus() {
        return {
            totalJobs: this.jobs.size,
            stats: this.getStats(),
            tasks: this.getAllTasks()
        };
    }

    /**
     * 清理所有任务（优雅关闭时调用）
     */
    async cleanup() {
        this.logger?.info('[调度管理] 开始清理资源');

        // 取消所有任务
        for (const taskId of this.jobs.keys()) {
            this.cancelTask(taskId);
        }

        // 等待所有调度任务完成
        await schedule.gracefulShutdown();

        // 输出统计信息
        const stats = this.getStats();
        this.logger?.info('[调度管理] 最终统计:', stats);

        this.logger?.info('[调度管理] 资源清理完成');
    }
}
