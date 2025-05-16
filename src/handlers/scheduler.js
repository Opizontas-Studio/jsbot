import schedule from 'node-schedule';
import { dbManager } from '../db/dbManager.js';
import { ProcessModel } from '../db/models/processModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import CourtService from '../services/courtService.js';
import { monitorService } from '../services/monitorService.js';
import PunishmentService from '../services/punishmentService.js';
import { executeThreadManagement } from '../services/threadAnalyzer.js';
import { VoteService } from '../services/voteService.js';
import { globalRequestQueue } from '../utils/concurrency.js';
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

/**
 * 流程到期调度器
 */
class ProcessScheduler {
    constructor() {
        this.jobs = new Map();
    }

    /**
     * 初始化流程调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        try {
            // 获取所有未完成的流程
            const processes = await ProcessModel.getAllProcesses(false);
            for (const process of processes) {
                await this.scheduleProcess(process, client);
            }
            logTime(`[定时任务] 已加载并调度 ${processes.length} 个流程的到期处理`);
        } catch (error) {
            logTime(`[定时任务] 加载和调度流程失败: ${error.message}`, true);
        }
    }

    /**
     * 调度单个流程的到期处理
     * @param {Object} process - 流程记录
     * @param {Object} client - Discord客户端
     */
    async scheduleProcess(process, client) {
        try {
            const now = Date.now();
            const expiryTime = new Date(process.expireAt);

            // 清除已存在的任务
            if (this.jobs.has(process.id)) {
                this.jobs.get(process.id).cancel();
                this.jobs.delete(process.id);
            }

            if (expiryTime.getTime() <= now) {
                // 已过期，直接处理
                await CourtService.handleProcessExpiry(process, client);
            } else {
                // 设置定时任务
                const job = schedule.scheduleJob(expiryTime, async () => {
                    // 检查流程状态
                    const currentProcess = await ProcessModel.getProcessById(process.id);
                    if (currentProcess && currentProcess.status === 'completed') {
                        logTime(`[定时任务] 流程 ${process.id} 已完成，跳过到期处理`);
                        return;
                    }
                    await CourtService.handleProcessExpiry(process, client);
                    this.jobs.delete(process.id);
                });

                this.jobs.set(process.id, job);
                logTime(`[定时任务] 已调度流程 ${process.id} 的到期处理，将在 ${expiryTime.toLocaleString()} 执行`);
            }
        } catch (error) {
            logTime(`[定时任务] 调度流程失败: ${error.message}`, true);
        }
    }

    /**
     * 取消流程的定时器
     * @param {number} processId - 流程ID
     */
    async cancelProcess(processId) {
        if (this.jobs.has(processId)) {
            this.jobs.get(processId).cancel();
            this.jobs.delete(processId);
            logTime(`[定时任务] 已取消流程 ${processId} 的定时器`);
        }
    }

    /**
     * 清理所有定时器
     */
    cleanup() {
        for (const job of this.jobs.values()) {
            job.cancel();
        }
        this.jobs.clear();
        logTime('[定时任务] 已清理所有流程到期定时器');
    }
}

/**
 * 处罚到期调度器
 */
class PunishmentScheduler {
    constructor() {
        this.timers = new Map();
        this.jobs = new Map();
    }

    /**
     * 初始化处罚调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        try {
            // 获取所有活跃的处罚
            const punishments = await dbManager.safeExecute(
                'all',
                `SELECT * FROM punishments
                WHERE status = 'active'
                AND (duration > 0 OR warningDuration > 0)`,
                [],
            );

            // 处理返回的数据
            const activePunishments = punishments.map(p => ({
                ...p,
                keepMessages: Boolean(p.keepMessages),
                duration: Number(p.duration),
                warningDuration: p.warningDuration ? Number(p.warningDuration) : null,
                syncedServers: JSON.parse(p.syncedServers || '[]'),
            }));

            // 调度处罚到期处理
            for (const punishment of activePunishments) {
                await this.schedulePunishment(punishment, client);
            }
        } catch (error) {
            logTime(`[定时任务] 加载和调度处罚失败: ${error.message}`, true);
        }
    }

    /**
     * 调度单个处罚的到期处理
     * @param {Object} punishment - 处罚记录
     * @param {Object} client - Discord客户端
     */
    async schedulePunishment(punishment, client) {
        try {
            // 计算到期时间
            const expiryTime = new Date(Math.max(
                punishment.duration > 0 ? punishment.createdAt + punishment.duration : 0,
                punishment.warningDuration ? punishment.createdAt + punishment.warningDuration : 0
            ));

            if (expiryTime.getTime() > 0) {
                // 使用node-schedule直接调度到特定日期
                const job = schedule.scheduleJob(expiryTime, async function() {
                    await PunishmentService.handleExpiry(client, punishment);
                });
                logTime(`[定时任务] 已调度处罚 ${punishment.id} 的到期处理，将在 ${expiryTime.toLocaleString()} 执行`);
                this.jobs.set(punishment.id, job);
            }
        } catch (error) {
            logTime(`[定时任务] 调度处罚失败 [ID: ${punishment.id}]: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清理所有定时器
     */
    cleanup() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.jobs.clear();
        logTime('[定时任务] 已清理所有处罚到期定时器');
    }
}

/**
 * 投票调度器
 */
class VoteScheduler {
    constructor() {
        this.jobs = new Map(); // 存储所有投票的定时任务
        this.votes = new Map(); // 存储所有活跃投票的状态
    }

    /**
     * 初始化投票调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        try {
            // 获取所有进行中的投票
            const votes = await dbManager.safeExecute(
                'all',
                `SELECT * FROM votes
                WHERE status = 'in_progress'
                AND endTime > ?`,
                [Date.now()],
            );

            for (const vote of votes) {
                await this.scheduleVote(vote, client);
            }
        } catch (error) {
            logTime(`加载和调度投票失败: ${error.message}`, true);
        }
    }

    /**
     * 调度单个投票的状态更新
     * @param {Object} vote - 投票记录
     * @param {Object} client - Discord客户端
     */
    async scheduleVote(vote, client) {
        try {
            const now = Date.now();

            // 直接使用VoteModel获取已解析的数据
            const parsedVote = await VoteModel.getVoteById(vote.id);
            if (!parsedVote) {
                throw new Error(`无法获取投票数据`);
            }

            // 验证必要字段
            if (!parsedVote.threadId || !parsedVote.messageId) {
                throw new Error(`缺少必要字段: threadId=${parsedVote.threadId}, messageId=${parsedVote.messageId}`);
            }

            // 存储投票状态
            this.votes.set(vote.id, parsedVote);

            // 清除已存在的定时器
            this.clearVoteTimers(vote.id);

            // 设置结束时间定时器
            if (now < parsedVote.endTime) {
                const endTime = new Date(parsedVote.endTime);
                const endJob = schedule.scheduleJob(endTime, async () => {
                    try {
                        // 获取最新的投票状态，检查是否已经结束
                        const currentVote = await VoteModel.getVoteById(vote.id);
                        if (!currentVote || currentVote.status === 'completed') {
                            logTime(`[定时任务] 投票 ${vote.id} 已完成，跳过定时器结算`);
                            return;
                        }

                        const channel = await client.channels.fetch(parsedVote.threadId);
                        if (!channel) {
                            logTime(`无法获取频道 [ID: ${parsedVote.threadId}]`, true);
                            return;
                        }

                        const message = await channel.messages.fetch(parsedVote.messageId);
                        if (!message) {
                            logTime(`无法获取消息 [ID: ${parsedVote.messageId}]`, true);
                            return;
                        }

                        const { result, message: resultMessage } = await VoteService.executeVoteResult(
                            currentVote,
                            client,
                        );

                        // 获取最新的投票状态
                        const finalVote = await VoteModel.getVoteById(vote.id);

                        // 更新消息显示结果
                        await VoteService.updateVoteMessage(message, finalVote, {
                            result,
                            message: resultMessage,
                        });

                        // 清理投票状态
                        this.votes.delete(vote.id);
                        this.clearVoteTimers(vote.id);
                    } catch (error) {
                        logTime(`处理投票结束失败 [ID: ${vote.id}]: ${error.message}`, true);
                    }
                });

                this.jobs.set(`end_${vote.id}`, endJob);
                logTime(`[定时任务] 已设置投票 ${vote.id} 的结束定时器，将在 ${endTime.toLocaleString()} 结束`);
            }
        } catch (error) {
            logTime(`调度投票失败 [ID: ${vote.id}]: ${error.message}`, true);
            // 确保清理任何可能已创建的定时器
            this.clearVoteTimers(vote.id);
            this.votes.delete(vote.id);
            throw error;
        }
    }

    /**
     * 清理指定投票的定时器
     * @param {number} voteId - 投票ID
     */
    clearVoteTimers(voteId) {
        const publicJob = this.jobs.get(`public_${voteId}`);
        if (publicJob) {
            publicJob.cancel();
            this.jobs.delete(`public_${voteId}`);
        }

        const endJob = this.jobs.get(`end_${voteId}`);
        if (endJob) {
            endJob.cancel();
            this.jobs.delete(`end_${voteId}`);
        }
    }

    /**
     * 清理所有定时器和状态
     */
    cleanup() {
        for (const job of this.jobs.values()) {
            job.cancel();
        }
        this.jobs.clear();
        this.votes.clear();
        logTime('[定时任务] 已清理所有投票定时器和状态');
    }
}

/**
 * 定时任务管理器
 * 用于集中管理所有的定时任务，包括：
 * - 子区分析和清理
 * - 处罚到期检查
 * - 投票状态更新
 * - 数据库备份
 * - 其他周期性任务
 */
class TaskScheduler {
    constructor() {
        this.jobs = new Map(); // 存储定时任务
        this.tasks = new Map(); // 存储任务配置
        this.processScheduler = new ProcessScheduler();
        this.punishmentScheduler = new PunishmentScheduler();
        this.voteScheduler = new VoteScheduler();
        this.isInitialized = false;
    }

    // 初始化任务调度器
    async initialize(client) {
        if (this.isInitialized) {
            logTime('[定时任务] 任务调度器已经初始化');
            return;
        }

        // 保存client引用以供重载任务使用
        this.client = client;

        try {
            // 初始化流程和处罚调度器
            await this.processScheduler.initialize(client);
            await this.punishmentScheduler.initialize(client);
            await this.voteScheduler.initialize(client);

            // 注册各类定时任务
            this.registerAnalysisTasks(client);
            this.registerDatabaseTasks();
            this.registerMonitorTasks(client);

            this.isInitialized = true;
        } catch (error) {
            logTime(`任务调度器初始化失败: ${error.message}`, true);
            throw error;
        }
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
        // 清除已存在的定时器
        this.removeTask(taskId);

        // 包装任务执行函数，统一错误处理
        const wrappedTask = async () => {
            try {
                await task();
            } catch (error) {
                logTime(`任务 ${taskId} 执行失败: ${error.message}`, true);
            }
        };

        // 创建每日执行规则
        const rule = new schedule.RecurrenceRule();
        rule.hour = hour;
        rule.minute = minute;
        rule.second = 0;

        // 创建定时任务
        const job = schedule.scheduleJob(rule, wrappedTask);
        this.jobs.set(taskId, job);

        // 构建任务信息日志
        const nextInvocation = job.nextInvocation();
        const taskInfo = [
            `每日定时任务: ${taskId}`,
            `执行时间: 每天${hour}:${minute.toString().padStart(2, '0')}`,
            `下次执行: ${nextInvocation.toLocaleString()}`
        ];

        // 如果需要立即执行一次
        if (runImmediately) {
            taskInfo.push('立即执行: 是');
            wrappedTask();
        }

        // 输出统一格式的日志
        logTime(taskInfo.join(' | '));

        // 存储任务信息
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
        // 清除已存在的定时器
        this.removeTask(taskId);

        // 包装任务执行函数，统一错误处理
        const wrappedTask = async () => {
            try {
                await task();
            } catch (error) {
                logTime(`任务 ${taskId} 执行失败: ${error.message}`, true);
            }
        };

        // 构建任务信息日志
        const taskInfo = [`定时任务: ${taskId}`, `执行间隔: ${formatInterval(interval)}`];

        // 创建调度规则
        let rule;

        if (startAt) {
            // 如果指定了开始时间，先安排一次性任务
            const firstExecutionTime = new Date(startAt);
            taskInfo.push(`首次执行: ${firstExecutionTime.toLocaleString()}`);

            // 为第一次执行创建一次性任务
            const firstJob = schedule.scheduleJob(firstExecutionTime, async () => {
                await wrappedTask();

                // 然后创建循环任务
                const recurringRule = new schedule.RecurrenceRule();
                recurringRule.second = new schedule.Range(0, 59, Math.floor(interval / 1000));

                const recurringJob = schedule.scheduleJob(recurringRule, wrappedTask);
                this.jobs.set(taskId, recurringJob);
            });

            this.jobs.set(`${taskId}_first`, firstJob);
        } else {
            // 创建循环执行规则
            rule = new schedule.RecurrenceRule();
            rule.second = new schedule.Range(0, 59, Math.floor(interval / 1000));

            // 创建定时任务
            const job = schedule.scheduleJob(rule, wrappedTask);
            this.jobs.set(taskId, job);

            // 如果需要立即执行一次
            if (runImmediately) {
                taskInfo.push('立即执行: 是');
                wrappedTask();
            }
        }

        // 输出统一格式的日志
        logTime(taskInfo.join(' | '));

        // 存储任务信息
        this.tasks.set(taskId, { interval, task });
    }

    // 移除指定任务
    removeTask(taskId) {
        // 移除常规任务
        if (this.jobs.has(taskId)) {
            this.jobs.get(taskId).cancel();
            this.jobs.delete(taskId);
        }

        // 移除首次执行任务（如果存在）
        if (this.jobs.has(`${taskId}_first`)) {
            this.jobs.get(`${taskId}_first`).cancel();
            this.jobs.delete(`${taskId}_first`);
        }

        this.tasks.delete(taskId);
    }

    // 注册数据库相关任务
    registerDatabaseTasks() {
        // 数据库备份任务 - 每天早上6点执行
        this.addDailyTask({
            taskId: 'databaseBackup',
            hour: 6,
            minute: 0,
            task: async () => {
                try {
                    await dbManager.backup();
                    logTime('[定时任务] 数据库备份完成');
                } catch (error) {
                    logTime(`[定时任务] 数据库备份失败: ${error.message}`, true);
                }
            },
        });

        // 重新加载所有流程和处罚的定时任务 - 每天凌晨3点执行
        this.addDailyTask({
            taskId: 'reloadSchedulers',
            hour: 3,
            minute: 0,
            task: async () => {
                try {
                    // 清理现有定时器
                    this.processScheduler.cleanup();
                    this.punishmentScheduler.cleanup();

                    // 重新初始化
                    await this.processScheduler.initialize(this.client);
                    await this.punishmentScheduler.initialize(this.client);

                    logTime('[定时任务] 所有流程和处罚定时器已重新加载完成');
                } catch (error) {
                    logTime(`[定时任务] 重新加载定时器失败: ${error.message}`, true);
                }
            },
        });
    }

    // 注册子区分析和清理任务
    registerAnalysisTasks(client) {
        // 获取所有启用了子区管理的服务器（mode不为disabled）
        const managedGuilds = Array.from(client.guildManager.guilds.entries())
            .filter(([_, config]) => config.automation?.mode !== 'disabled')
            .map(([guildId]) => guildId);

        if (managedGuilds.length === 0) return;

        // 为每个服务器设置错开的执行时间，避免同时执行过多任务
        managedGuilds.forEach((guildId, index) => {
            const guildConfig = client.guildManager.guilds.get(guildId);

            // 创建每2小时执行一次的规则
            // 将服务器的执行时间错开，每个服务器的分钟偏移量为index * 10
            const rule = new schedule.RecurrenceRule();
            // 设置分钟为当前服务器的偏移量
            const offsetMinute = (index * 10) % 60;
            rule.minute = offsetMinute;
            // 如果需要跨小时，则设置小时为偶数+偏移
            const hourOffset = Math.floor((index * 10) / 60) % 2;
            rule.hour = new schedule.Range(0, 23, 2, hourOffset);

            // 为该服务器创建定时任务
            const job = schedule.scheduleJob(rule, async () => {
                try {
                    await globalRequestQueue.add(async () => {
                        // 获取活跃子区数据
                        const guild = await client.guilds.fetch(guildId);
                        const activeThreads = await guild.channels.fetchActiveThreads();

                        // 执行子区管理（分析和/或清理）
                        await executeThreadManagement(client, guildConfig, guildId, activeThreads);
                    }, 0);

                    logTime(`[定时任务] 完成服务器 ${guildId} 的子区管理任务，下次执行时间：${job.nextInvocation().toLocaleString()}`);
                } catch (error) {
                    logTime(
                        `[定时任务] 服务器 ${guildId} 的定时任务执行失败: ${error.name}${
                            error.code ? ` (${error.code})` : ''
                        } - ${error.message}`,
                        true,
                    );
                }
            });

            // 存储任务
            this.jobs.set(`thread_management_${guildId}`, job);
        });
    }

    // 注册监控任务
    registerMonitorTasks(client) {
        // 从配置中获取监控频道ID和消息ID
        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            if (!guildConfig.monitor?.channelId || !guildConfig.monitor?.enabled) {
                continue;
            }

            // 创建每分钟执行一次的规则
            const rule = new schedule.RecurrenceRule();
            rule.second = 0; // 每分钟的0秒执行

            const job = schedule.scheduleJob(rule, async () => {
                try {
                    const channelId = guildConfig.monitor.channelId;
                    const messageId = guildConfig.monitor.messageId;
                    await monitorService.updateStatusMessage(client, channelId, messageId, guildId);
                } catch (error) {
                    logTime(`[定时任务] 监控任务执行失败 [服务器 ${guildId}]: ${error.message}`, true);
                }
            });

            // 存储任务
            this.jobs.set(`monitor_${guildId}`, job);

            // 立即执行一次
            (async () => {
                try {
                    const channelId = guildConfig.monitor.channelId;
                    const messageId = guildConfig.monitor.messageId;
                    await monitorService.updateStatusMessage(client, channelId, messageId, guildId);
                    logTime(`[定时任务] 已为服务器 ${guildId} 创建监控任务，每分钟执行一次，下次执行时间：${job.nextInvocation().toLocaleString()}`);
                } catch (error) {
                    logTime(`[定时任务] 初始监控任务执行失败 [服务器 ${guildId}]: ${error.message}`, true);
                }
            })();

            // 检查是否开启议员监控
            if (guildConfig.monitor?.roleMonitorCategoryId && guildConfig.roleApplication?.senatorRoleId) {
                // 创建每15分钟执行一次的规则
                const senatorRule = new schedule.RecurrenceRule();
                senatorRule.minute = new schedule.Range(0, 59, 15); // 每小时的0, 15, 30, 45分钟执行
                senatorRule.second = 30; // 错开时间，避免与其他任务冲突

                const senatorJob = schedule.scheduleJob(senatorRule, async () => {
                    try {
                        await monitorService.monitorSenatorRole(client, guildId);
                    } catch (error) {
                        logTime(`[定时任务] 议员监控任务执行失败 [服务器 ${guildId}]: ${error.message}`, true);
                    }
                });

                // 存储任务
                this.jobs.set(`senator_monitor_${guildId}`, senatorJob);

                // 立即执行一次
                (async () => {
                    try {
                        await monitorService.monitorSenatorRole(client, guildId);
                        logTime(`[定时任务] 已为服务器 ${guildId} 创建议员监控任务，每15分钟执行一次，下次执行时间：${senatorJob.nextInvocation().toLocaleString()}`);
                    } catch (error) {
                        logTime(`[定时任务] 初始议员监控任务执行失败 [服务器 ${guildId}]: ${error.message}`, true);
                    }
                })();
            }
        }
    }

    // 停止所有任务
    stopAll() {
        const taskCount = this.jobs.size;

        // 清理所有定时器
        for (const job of this.jobs.values()) {
            job.cancel();
        }

        // 清理流程和处罚调度器
        this.processScheduler.cleanup();
        this.punishmentScheduler.cleanup();
        this.voteScheduler.cleanup();

        if (taskCount > 0) {
            logTime(`已停止 ${taskCount} 个定时任务`);
        }
        this.jobs.clear();
        this.tasks.clear();
        this.isInitialized = false;
    }

    // 重启所有任务
    restart(client) {
        this.stopAll();
        this.initialize(client);
    }

    // 获取流程调度器
    getProcessScheduler() {
        return this.processScheduler;
    }

    // 获取处罚调度器
    getPunishmentScheduler() {
        return this.punishmentScheduler;
    }

    // 获取投票调度器
    getVoteScheduler() {
        return this.voteScheduler;
    }
}

// 创建全局单例
export const globalTaskScheduler = new TaskScheduler();
