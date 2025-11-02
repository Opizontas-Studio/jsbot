import schedule from 'node-schedule';
import { ProcessScheduler } from '../schedulers/processScheduler.js';
import { PunishmentScheduler } from '../schedulers/punishmentScheduler.js';
import { TaskRegistry } from '../schedulers/taskRegistry.js';
import { VoteScheduler } from '../schedulers/voteScheduler.js';
import { carouselServiceManager } from '../services/carouselService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

// 时间单位转换为毫秒 @private
const TIME_UNITS = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
};

// 格式化时间间隔 @private
const formatInterval = ms => {
    const parts = [];

    if (ms >= TIME_UNITS.DAY) {
        const days = Math.floor(ms / TIME_UNITS.DAY);
        parts.push(`${days}天`);
        ms %= TIME_UNITS.DAY;
    }

    if (ms >= TIME_UNITS.HOUR) {
        const hours = Math.floor(ms / TIME_UNITS.HOUR);
        parts.push(`${hours}小时`);
        ms %= TIME_UNITS.HOUR;
    }

    if (ms >= TIME_UNITS.MINUTE) {
        const minutes = Math.floor(ms / TIME_UNITS.MINUTE);
        parts.push(`${minutes}分钟`);
        ms %= TIME_UNITS.MINUTE;
    }

    if (ms >= TIME_UNITS.SECOND || parts.length === 0) {
        const seconds = Math.ceil(ms / TIME_UNITS.SECOND);
        parts.push(`${seconds}秒`);
    }

    return parts.join(' ');
};

// 任务日志工具 @private
const logTaskOperation = (taskId, operation, details = {}) => {
    const message = `[定时任务] ${taskId} - ${operation}`;
    const extras = Object.entries(details)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' | ');

    logTime(extras ? `${message} | ${extras}` : message);
};


/**
 * 定时任务管理器 - 核心调度功能
 * 专注于通用定时任务的调度和管理，不包含具体业务逻辑
 */
class TaskScheduler {
    constructor() {
        this.jobs = new Map(); // 存储定时任务
        this.tasks = new Map(); // 存储任务配置
        this.schedulers = new Map(); // 存储各种调度器
        this.taskRegistry = null; // 任务注册器
        this.isInitialized = false;
    }

    /**
     * 初始化任务调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        if (this.isInitialized) {
            logTime('[定时任务] 任务调度器已经初始化');
            return;
        }

        await ErrorHandler.handleService(
            async () => {
                // 初始化各种调度器
                this.schedulers.set('process', new ProcessScheduler());
                this.schedulers.set('punishment', new PunishmentScheduler());
                this.schedulers.set('vote', new VoteScheduler());

                // 初始化任务注册器
                this.taskRegistry = new TaskRegistry(this);

                // 初始化所有调度器
                await this.schedulers.get('process').initialize(client);
                await this.schedulers.get('punishment').initialize(client);
                await this.schedulers.get('vote').initialize(client);

                // 注册业务任务
                this.taskRegistry.registerAll(client);

                this.isInitialized = true;
                logTime('[定时任务] 任务调度器初始化完成');
            },
            "任务调度器初始化",
            { throwOnError: true }
        );
    }

    /**
     * 添加每日执行的任务
     * @param {Object} options - 任务配置
     * @param {string} options.taskId - 任务ID
     * @param {Function} options.task - 任务函数
     * @param {number} options.hour - 每天执行的小时（0-23）
     * @param {number} options.minute - 每天执行的分钟（0-59），默认为0
     * @param {boolean} [options.runImmediately=false] - 是否立即执行一次
     */
    addDailyTask({ taskId, task, hour, minute = 0, runImmediately = false }) {
        this.removeTask(taskId);

        // 统一使用错误容错处理
        const wrappedTask = () => ErrorHandler.handleSilent(
            task,
            `任务 ${taskId}`,
            null
        );

        // 创建每日执行规则
        const rule = new schedule.RecurrenceRule();
        rule.hour = hour;
        rule.minute = minute;
        rule.second = 0;

        const job = schedule.scheduleJob(rule, wrappedTask);
        this.jobs.set(taskId, job);

        // 记录任务信息
        const details = {
            "执行时间": `每天${hour}:${minute.toString().padStart(2, '0')}`,
            "下次执行": job.nextInvocation().toLocaleString()
        };

        if (runImmediately) {
            details["立即执行"] = "是";
            wrappedTask();
        }

        logTaskOperation(taskId, "已注册每日任务", details);
        this.tasks.set(taskId, { hour, minute, task });
    }

    /**
     * 添加定时任务
     * @param {Object} options - 任务配置
     * @param {string} options.taskId - 任务ID
     * @param {number} options.interval - 任务间隔（毫秒）
     * @param {Function} options.task - 任务函数
     * @param {Date} [options.startAt] - 首次执行时间
     * @param {boolean} [options.runImmediately=false] - 是否立即执行一次
     */
    addTask({ taskId, interval, task, startAt, runImmediately = false }) {
        this.removeTask(taskId);

        const wrappedTask = () => ErrorHandler.handleSilent(
            task,
            `任务 ${taskId}`,
            null
        );

        const details = { "执行间隔": formatInterval(interval) };

        // 创建递归调度函数
        const scheduleNext = () => {
            const nextTime = new Date(Date.now() + interval);
            const job = schedule.scheduleJob(nextTime, () => {
                // 检查任务是否仍然存在（防止已删除的任务继续执行）
                if (!this.tasks.has(taskId)) {
                    return;
                }

                wrappedTask();

                // 检查任务是否在执行过程中被删除
                if (this.tasks.has(taskId)) {
                    // 执行完后调度下一次
                    this.jobs.set(taskId, scheduleNext());
                }
            });
            return job;
        };

        if (startAt) {
            const firstExecutionTime = new Date(startAt);
            details["首次执行"] = firstExecutionTime.toLocaleString();

            // 创建首次执行任务
            const firstJob = schedule.scheduleJob(firstExecutionTime, () => {
                // 检查任务是否仍然存在
                if (!this.tasks.has(taskId)) {
                    return;
                }

                wrappedTask();

                // 检查任务是否在执行过程中被删除
                if (this.tasks.has(taskId)) {
                    // 首次执行后开始循环调度
                    this.jobs.set(taskId, scheduleNext());
                }
            });
            this.jobs.set(`${taskId}_first`, firstJob);
        } else {
            if (runImmediately) {
                details["立即执行"] = "是";
                wrappedTask();
            }

            // 创建循环任务
            this.jobs.set(taskId, scheduleNext());
        }

        logTaskOperation(taskId, "已注册定时任务", details);
        this.tasks.set(taskId, { interval, task });
    }

    /**
     * 移除指定任务
     * @param {string} taskId - 任务ID
     */
    removeTask(taskId) {
        // 移除常规任务
        const job = this.jobs.get(taskId);
        if (job) {
            job.cancel();
            this.jobs.delete(taskId);
        }

        // 移除首次执行任务
        const firstJob = this.jobs.get(`${taskId}_first`);
        if (firstJob) {
            firstJob.cancel();
            this.jobs.delete(`${taskId}_first`);
        }

        // 标记任务为已删除，防止递归调度继续
        this.tasks.delete(taskId);
    }

    /**
     * 注册调度器
     * @param {string} name - 调度器名称
     * @param {Object} scheduler - 调度器实例
     */
    registerScheduler(name, scheduler) {
        this.schedulers.set(name, scheduler);
    }

    /**
     * 获取调度器
     * @param {string} name - 调度器名称
     * @returns {Object|undefined} 调度器实例
     */
    getScheduler(name) {
        return this.schedulers.get(name);
    }

    /**
     * 添加自定义调度规则的任务
     * @param {Object} options - 任务配置
     * @param {string} options.taskId - 任务ID
     * @param {Function} options.task - 任务函数
     * @param {Object} options.rule - node-schedule 的 RecurrenceRule 或 Date
     * @param {string} [options.description] - 任务描述（用于日志）
     * @param {boolean} [options.runImmediately=false] - 是否立即执行一次
     */
    addCustomTask({ taskId, task, rule, description, runImmediately = false }) {
        this.removeTask(taskId);

        // 统一使用错误容错处理
        const wrappedTask = () => ErrorHandler.handleSilent(
            task,
            `任务 ${taskId}`,
            null
        );

        const job = schedule.scheduleJob(rule, wrappedTask);
        this.jobs.set(taskId, job);

        // 记录任务信息
        const details = {};
        if (description) {
            details["任务描述"] = description;
        }

        const nextInvocation = job.nextInvocation();
        if (nextInvocation) {
            details["下次执行"] = nextInvocation.toLocaleString();
        }

        if (runImmediately) {
            details["立即执行"] = "是";
            wrappedTask();
        }

        logTaskOperation(taskId, "已注册自定义任务", details);
        this.tasks.set(taskId, { rule, task, description });
    }

    /**
     * 停止所有任务
     */
    stopAll() {
        const taskCount = this.jobs.size;

        // 清理所有定时器
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        // 清理所有调度器
        for (const scheduler of this.schedulers.values()) {
            scheduler.cleanup?.();
        }

        // 停止所有轮播
        carouselServiceManager.stopAll();

        if (taskCount > 0) {
            logTime(`[定时任务] 已停止 ${taskCount} 个定时任务`);
        }
        this.jobs.clear();
        this.tasks.clear();
        this.schedulers.clear();
        this.isInitialized = false;
    }

    /**
     * 重启所有任务
     * @param {Object} client - Discord客户端
     */
    restart(client) {
        this.stopAll();
        this.initialize(client);
    }
}

// 创建全局单例
export const globalTaskScheduler = new TaskScheduler();
