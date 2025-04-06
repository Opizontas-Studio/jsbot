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
        this.timers = new Map();
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
            logTime(`已加载并调度 ${processes.length} 个流程的到期处理`);
        } catch (error) {
            logTime(`加载和调度流程失败: ${error.message}`, true);
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
            const timeUntilExpiry = process.expireAt - now;

            // 清除已存在的定时器
            if (this.timers.has(process.id)) {
                clearTimeout(this.timers.get(process.id));
                this.timers.delete(process.id);
            }

            if (timeUntilExpiry <= 0) {
                // 已过期，直接处理
                await CourtService.handleProcessExpiry(process, client);
            } else {
                // 设置定时器
                const timer = setTimeout(async () => {
                    // 检查流程状态
                    const currentProcess = await ProcessModel.getProcessById(process.id);
                    if (currentProcess && currentProcess.status === 'completed') {
                        logTime(`流程 ${process.id} 已完成，跳过到期处理`);
                        return;
                    }
                    await CourtService.handleProcessExpiry(process, client);
                    this.timers.delete(process.id);
                }, timeUntilExpiry);

                this.timers.set(process.id, timer);
                logTime(`已调度流程 ${process.id} 的到期处理，将在 ${Math.ceil(timeUntilExpiry / 1000)} 秒后执行`);
            }
        } catch (error) {
            logTime(`调度流程失败: ${error.message}`, true);
        }
    }

    /**
     * 取消流程的定时器
     * @param {number} processId - 流程ID
     */
    async cancelProcess(processId) {
        if (this.timers.has(processId)) {
            clearTimeout(this.timers.get(processId));
            this.timers.delete(processId);
            logTime(`已取消流程 ${processId} 的定时器`);
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
        logTime('已清理所有流程到期定时器');
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
            logTime(`加载和调度处罚失败: ${error.message}`, true);
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
                logTime(`已调度处罚 ${punishment.id} 的到期处理，将在 ${expiryTime.toLocaleString()} 执行`);
                this.jobs.set(punishment.id, job);
            }
        } catch (error) {
            logTime(`调度处罚失败 [ID: ${punishment.id}]: ${error.message}`, true);
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
        logTime('已清理所有处罚到期定时器');
    }
}

/**
 * 投票调度器
 */
class VoteScheduler {
    constructor() {
        this.timers = new Map(); // 存储所有投票的定时器
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
                AND (publicTime > ? OR endTime > ?)`,
                [Date.now(), Date.now()],
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

            // 设置公开时间定时器
            if (now < parsedVote.publicTime) {
                const publicDelay = parsedVote.publicTime - now;
                const publicTimer = setTimeout(async () => {
                    try {
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

                        // 获取最新的投票状态
                        const currentVote = await VoteModel.getVoteById(vote.id);
                        if (!currentVote) {
                            logTime(`无法获取投票 [ID: ${vote.id}]`, true);
                            return;
                        }

                        await VoteService.updateVoteMessage(message, currentVote, { isSchedulerUpdate: true });
                    } catch (error) {
                        logTime(`处理投票公开失败 [ID: ${vote.id}]: ${error.message}`, true);
                    }
                }, publicDelay);

                this.timers.set(`public_${vote.id}`, publicTimer);
                logTime(`已设置投票 ${vote.id} 的公开定时器，将在 ${Math.ceil(publicDelay / 1000)}秒后公开`);
            }

            // 设置结束时间定时器
            if (now < parsedVote.endTime) {
                const endDelay = parsedVote.endTime - now;
                const endTimer = setTimeout(async () => {
                    try {
                        // 获取最新的投票状态，检查是否已经结束
                        const currentVote = await VoteModel.getVoteById(vote.id);
                        if (!currentVote || currentVote.status === 'completed') {
                            logTime(`投票 ${vote.id} 已完成，跳过定时器结算`);
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
                }, endDelay);

                this.timers.set(`end_${vote.id}`, endTimer);
                logTime(`已设置投票 ${vote.id} 的结束定时器，将在 ${Math.ceil(endDelay / 1000)}秒后结束`);
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
        const publicTimer = this.timers.get(`public_${voteId}`);
        if (publicTimer) {
            clearTimeout(publicTimer);
            this.timers.delete(`public_${voteId}`);
        }

        const endTimer = this.timers.get(`end_${voteId}`);
        if (endTimer) {
            clearTimeout(endTimer);
            this.timers.delete(`end_${voteId}`);
        }
    }

    /**
     * 清理所有定时器和状态
     */
    cleanup() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.votes.clear();
        logTime('已清理所有投票定时器和状态');
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
        this.timers = new Map(); // 存储定时器ID
        this.tasks = new Map(); // 存储任务配置
        this.processScheduler = new ProcessScheduler();
        this.punishmentScheduler = new PunishmentScheduler();
        this.voteScheduler = new VoteScheduler();
        this.isInitialized = false;
    }

    // 初始化任务调度器
    async initialize(client) {
        if (this.isInitialized) {
            logTime('任务调度器已经初始化');
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

        // 计算首次执行的延迟
        let initialDelay = 0;
        if (startAt) {
            const now = new Date();
            initialDelay = startAt - now;
            if (initialDelay <= 0) {
                initialDelay = interval - (-initialDelay % interval);
            }
        }

        // 构建任务信息日志
        const taskInfo = [`定时任务: ${taskId}`, `执行间隔: ${formatInterval(interval)}`];

        if (startAt) {
            const executionTime = new Date(Date.now() + initialDelay);
            taskInfo.push(`首次执行: ${executionTime.toLocaleString()}`);
        } else if (runImmediately) {
            taskInfo.push('立即执行: 是');
        }

        // 输出统一格式的日志
        logTime(taskInfo.join(' | '));

        // 如果需要立即执行
        if (runImmediately) {
            wrappedTask();
        }

        // 创建定时器
        let timer;
        if (initialDelay > 0) {
            // 首先设置一个一次性的定时器来处理首次执行
            timer = setTimeout(() => {
                wrappedTask();
                // 然后设置固定间隔的定时器
                timer = setInterval(wrappedTask, interval);
                this.timers.set(taskId, timer);
            }, initialDelay);
        } else {
            // 直接设置固定间隔的定时器
            timer = setInterval(wrappedTask, interval);
        }

        // 存储任务信息
        this.timers.set(taskId, timer);
        this.tasks.set(taskId, { interval, task });
    }

    // 移除指定任务
    removeTask(taskId) {
        if (this.timers.has(taskId)) {
            clearInterval(this.timers.get(taskId));
            this.timers.delete(taskId);
            this.tasks.delete(taskId);
        }
    }
    // 注册数据库相关任务
    registerDatabaseTasks() {
        // 计算下一个早上6点
        const now = new Date();
        const nextBackup = new Date(now);
        nextBackup.setHours(6, 0, 0, 0);
        if (nextBackup <= now) {
            nextBackup.setDate(nextBackup.getDate() + 1);
        }

        // 数据库备份任务
        this.addTask({
            taskId: 'databaseBackup',
            interval: TIME_UNITS.DAY,
            startAt: nextBackup,
            task: async () => {
                try {
                    await dbManager.backup();
                    logTime('数据库备份完成');
                } catch (error) {
                    logTime(`数据库备份失败: ${error.message}`, true);
                }
            },
        });

        // 计算下一个凌晨3点（选择低峰时段）
        const nextReload = new Date(now);
        nextReload.setHours(3, 0, 0, 0);
        if (nextReload <= now) {
            nextReload.setDate(nextReload.getDate() + 1);
        }

        // 重新加载所有流程和处罚的定时任务
        this.addTask({
            taskId: 'reloadSchedulers',
            interval: TIME_UNITS.DAY,
            startAt: nextReload,
            task: async () => {
                try {
                    // 清理现有定时器
                    this.processScheduler.cleanup();
                    this.punishmentScheduler.cleanup();

                    // 重新初始化
                    await this.processScheduler.initialize(this.client);
                    await this.punishmentScheduler.initialize(this.client);

                    logTime('所有流程和处罚定时器已重新加载完成');
                } catch (error) {
                    logTime(`重新加载定时器失败: ${error.message}`, true);
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

        // 计算当前时间到下一个整点的时间
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);

        // 为每个服务器设置错开的执行时间
        managedGuilds.forEach((guildId, index) => {
            const guildConfig = client.guildManager.guilds.get(guildId);

            // 计算该服务器的首次执行时间
            // 基础时间为下一个整点，每个服务器额外延迟10分钟 * index
            const initialDelay = nextHour.getTime() - now.getTime() + (index * 10 * TIME_UNITS.MINUTE);
            const startTime = new Date(now.getTime() + initialDelay);

            this.addTask({
                taskId: `thread_management_${guildId}`,
                interval: 2 * TIME_UNITS.HOUR, // 2小时间隔
                startAt: startTime,
                task: async () => {
                    try {
                        await globalRequestQueue.add(async () => {
                            // 获取活跃子区数据
                            const guild = await client.guilds.fetch(guildId);
                            const activeThreads = await guild.channels.fetchActiveThreads();

                            // 执行子区管理（分析和/或清理）
                            await executeThreadManagement(client, guildConfig, guildId, activeThreads);
                        }, 0);

                        logTime(`完成服务器 ${guildId} 的子区管理任务，下次执行时间：${new Date(Date.now() + 2 * TIME_UNITS.HOUR).toLocaleString()}`);
                    } catch (error) {
                        logTime(
                            `服务器 ${guildId} 的定时任务执行失败: ${error.name}${
                                error.code ? ` (${error.code})` : ''
                            } - ${error.message}`,
                            true,
                        );
                    }
                },
            });

            // 输出调度信息
            const modeText = guildConfig.automation.mode === 'analysis' ? '分析' : '分析和清理';
            logTime(`已为服务器 ${guildId} 调度子区${modeText}任务，首次执行时间：${startTime.toLocaleString()}`);
        });
    }

    // 注册监控任务
    registerMonitorTasks(client) {
        // 从配置中获取监控频道ID和消息ID
        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            if (!guildConfig.monitor?.channelId || !guildConfig.monitor?.enabled) {
                continue;
            }

            this.addTask({
                taskId: `monitor_${guildId}`,
                interval: TIME_UNITS.MINUTE,
                runImmediately: true,
                task: async () => {
                    try {
                        const channelId = guildConfig.monitor.channelId;
                        const messageId = guildConfig.monitor.messageId;
                        await monitorService.updateStatusMessage(client, channelId, messageId, guildId);
                    } catch (error) {
                        logTime(`监控任务执行失败 [服务器 ${guildId}]: ${error.message}`, true);
                    }
                },
            });
        }
    }

    // 停止所有任务
    stopAll() {
        const taskCount = this.timers.size;

        // 清理所有定时器
        for (const timer of this.timers.values()) {
            clearInterval(timer);
        }

        // 清理流程和处罚调度器
        this.processScheduler.cleanup();
        this.punishmentScheduler.cleanup();
        this.voteScheduler.cleanup();

        if (taskCount > 0) {
            logTime(`已停止 ${taskCount} 个定时任务`);
        }
        this.timers.clear();
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
