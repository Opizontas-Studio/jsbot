import { dbManager } from '../db/dbManager.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import CourtService from '../services/courtService.js';
import PunishmentService from '../services/punishmentService.js';
import { analyzeForumActivity, cleanupInactiveThreads } from '../services/threadAnalyzer.js';
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
            // 检查是否为议事流程
            if (!process.type.startsWith('court_') && !process.type.startsWith('appeal') && process.type !== 'debate')
                return;

            // 检查流程状态
            if (process.status === 'completed') {
                logTime(`流程 ${process.id} 已完成，跳过到期处理`);
                return;
            }

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
                    // 在执行到期处理前再次检查流程状态
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

            for (const punishment of activePunishments) {
                await this.schedulePunishment(punishment, client);
            }
            logTime(`已加载并调度 ${activePunishments.length} 个处罚的到期处理`);
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
            if (punishment.status !== 'active') {
                return;
            }

            const now = Date.now();
            // 计算到期时间（取禁言和警告中较长的时间）
            const muteDuration = punishment.duration > 0 ? punishment.createdAt + punishment.duration : 0;
            const warnDuration = punishment.warningDuration ? punishment.createdAt + punishment.warningDuration : 0;
            const expiryTime = Math.max(muteDuration, warnDuration);

            // 如果没有到期时间（永久处罚）或已经过期，直接返回
            if (expiryTime === 0) {
                return;
            }

            // 如果已经过期，直接处理
            if (expiryTime <= now && punishment.status === 'active') {
                await PunishmentService.handleExpiry(client, punishment);
                return;
            }

            // 清除已存在的定时器
            if (this.timers.has(punishment.id)) {
                clearTimeout(this.timers.get(punishment.id));
                this.timers.delete(punishment.id);
            }

            // 计算延迟时间
            const delay = expiryTime - now;

            // 设置最大延迟为 24.85 天 (2147483647 毫秒)
            const MAX_TIMEOUT = 2147483647;

            if (delay > MAX_TIMEOUT) {
                // 如果延迟时间超过最大值，设置一个中间定时器
                const timer = setTimeout(async () => {
                    // 重新调度剩余时间
                    await this.schedulePunishment(punishment, client);
                }, MAX_TIMEOUT);

                this.timers.set(punishment.id, timer);
                logTime(`已为处罚 ${punishment.id} 设置中间定时器，将在 ${formatInterval(MAX_TIMEOUT)} 后重新调度`);
            } else {
                // 设置到期定时器
                const timer = setTimeout(async () => {
                    try {
                        // 在执行到期处理前再次检查处罚状态
                        const currentPunishment = await PunishmentModel.getPunishmentById(punishment.id);
                        if (currentPunishment && currentPunishment.status === 'active') {
                            await PunishmentService.handleExpiry(client, currentPunishment);
                        }
                    } catch (error) {
                        logTime(`处理处罚到期失败 [ID: ${punishment.id}]: ${error.message}`, true);
                    } finally {
                        this.timers.delete(punishment.id);
                    }
                }, delay);

                this.timers.set(punishment.id, timer);
                logTime(`已调度处罚 ${punishment.id} 的到期处理，将在 ${formatInterval(delay)} 后执行`);
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
            logTime(`已加载并调度 ${votes.length} 个投票的状态更新`);
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

            // 安全解析 JSON 字段
            let parsedVote = { ...vote };

            // 处理 redVoters
            if (Array.isArray(vote.redVoters)) {
                parsedVote.redVoters = vote.redVoters;
            } else {
                parsedVote.redVoters = [];
                logTime(`redVoters 不是数组 [ID: ${vote.id}], 使用空数组`);
            }

            // 处理 blueVoters
            if (Array.isArray(vote.blueVoters)) {
                parsedVote.blueVoters = vote.blueVoters;
            } else {
                parsedVote.blueVoters = [];
                logTime(`blueVoters 不是数组 [ID: ${vote.id}], 使用空数组`);
            }

            // 处理 details
            if (typeof vote.details === 'object' && vote.details !== null) {
                parsedVote.details = vote.details;
            } else {
                parsedVote.details = {};
                logTime(`details 不是对象 [ID: ${vote.id}], 使用空对象`);
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
                logTime(`计算公开延迟 [ID: ${vote.id}]: ${publicDelay}ms (${publicDelay / 1000}秒)`);

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
                logTime(
                    `已设置投票公开定时器 [ID: ${vote.id}] - 将在 ${new Date(
                        parsedVote.publicTime,
                    ).toLocaleTimeString()} 公开`,
                );
            }

            // 设置结束时间定时器
            if (now < parsedVote.endTime) {
                const endDelay = parsedVote.endTime - now;
                logTime(`计算结束延迟 [ID: ${vote.id}]: ${endDelay}ms (${endDelay / 1000}秒)`);

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
                logTime(
                    `已设置投票结束定时器 [ID: ${vote.id}] - 将在 ${new Date(
                        parsedVote.endTime,
                    ).toLocaleTimeString()} 结束`,
                );
            }

            logTime(`已完成投票 ${vote.id} 的调度设置`);
        } catch (error) {
            logTime(`调度投票失败 [ID: ${vote.id}]: ${error.message}`, true);
            // 确保清理任何可能已创建的定时器
            this.clearVoteTimers(vote.id);
            this.votes.delete(vote.id);
            throw error; // 重新抛出错误以便上层处理
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

        // 初始化流程和处罚调度器
        await this.processScheduler.initialize(client);
        await this.punishmentScheduler.initialize(client);
        await this.voteScheduler.initialize(client);

        // 注册各类定时任务
        this.registerAnalysisTasks(client);
        this.registerDatabaseTasks();

        this.isInitialized = true;
        logTime('任务调度器初始化完成');
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
        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            if (!guildConfig.automation?.analysis) {
                continue;
            }

            // 计算下次整点执行时间
            const now = new Date();
            const nextRun = new Date(now);
            nextRun.setHours(nextRun.getHours() + 1, 0, 0, 0);

            this.addTask({
                taskId: `analysis_${guildId}`,
                interval: TIME_UNITS.HOUR,
                startAt: nextRun,
                task: async () => {
                    try {
                        await this.executeThreadTasks(client, guildConfig, guildId);
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
        }
    }

    // 执行子区分析和清理任务
    async executeThreadTasks(client, guildConfig, guildId) {
        try {
            await globalRequestQueue.add(async () => {
                // 获取活跃子区数据
                const guild = await client.guilds.fetch(guildId);
                const activeThreads = await guild.channels.fetchActiveThreads();

                // 执行分析和清理
                if (guildConfig.automation?.analysis) {
                    await analyzeForumActivity(client, guildConfig, guildId, activeThreads);
                }

                if (guildConfig.automation?.cleanup?.enabled) {
                    const threshold = guildConfig.automation.cleanup.threshold || 960;
                    await cleanupInactiveThreads(client, guildConfig, guildId, threshold, activeThreads);
                }
            }, 0);
        } catch (error) {
            logTime(
                `服务器 ${guildId} 的定时任务执行失败: ${error.name}${error.code ? ` (${error.code})` : ''} - ${
                    error.message
                }`,
                true,
            );
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
