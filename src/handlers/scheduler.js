import { dbManager } from '../db/manager.js';
import { ProcessModel } from '../db/models/process.js';
import { PunishmentModel } from '../db/models/punishment.js';
import { analyzeForumActivity, cleanupInactiveThreads } from '../services/analyzers.js';
import PunishmentService from '../services/punishment_service.js';
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
const formatInterval = (ms) => {
    if (ms >= TIME_UNITS.DAY) return `${Math.floor(ms / TIME_UNITS.DAY)}天`;
    if (ms >= TIME_UNITS.HOUR) return `${Math.floor(ms / TIME_UNITS.HOUR)}小时`;
    if (ms >= TIME_UNITS.MINUTE) return `${Math.floor(ms / TIME_UNITS.MINUTE)}分钟`;
    return `${Math.floor(ms / TIME_UNITS.SECOND)}秒`;
};

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
	    this.isInitialized = false;
    }

    // 初始化任务调度器
    initialize(client) {
	    if (this.isInitialized) {
	        logTime('任务调度器已经初始化');
	        return;
	    }

	    // 注册各类定时任务
	    this.registerAnalysisTasks(client);
	    this.registerPunishmentTasks(client);
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
	    const taskInfo = [
	        `定时任务: ${taskId}`,
	        `执行间隔: ${formatInterval(interval)}`,
	    ];

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
    }

    // 注册子区分析和清理任务
    registerAnalysisTasks(client) {
	    for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
	        if (!guildConfig.automation?.analysis) continue;

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
	                    logTime(`服务器 ${guildId} 定时任务执行出错: ${error}`, true);
	                }
	            },
	        });
	    }
    }

    // 注册处罚系统相关任务
    registerPunishmentTasks(client) {
	    // 处罚到期检查
	    this.addTask({
	        taskId: 'punishmentCheck',
	        interval: 30 * TIME_UNITS.SECOND,
	        runImmediately: true,
	        task: async () => {
	            try {
	                const expiredPunishments = await PunishmentModel.handleExpiredPunishments();
	                for (const punishment of expiredPunishments) {
	                    await this.executePunishmentExpiry(client, punishment);
	                }
	            } catch (error) {
	                logTime(`处理过期处罚失败: ${error.message}`, true);
	            }
	        },
	    });

	    // 加载并调度所有未过期的流程
	    this.addTask({
	        taskId: 'processScheduler',
	        interval: 24 * TIME_UNITS.HOUR, // 每24小时重新加载一次，以防遗漏
	        runImmediately: true,
	        task: async () => {
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
	        },
	    });
    }

    /**
     * 调度单个流程的到期处理
     * @param {Object} process - 流程记录
     * @param {Object} client - Discord客户端
     * @returns {Promise<void>}
     */
    async scheduleProcess(process, client) {
	    try {
	        // 检查是否为议事流程
	        if (!process.type.startsWith('court_') && !process.type.startsWith('appeal')) return;

	        // 检查流程状态，如果已经完成则不需要处理到期
	        if (process.status === 'completed') {
	            logTime(`流程 ${process.id} 已完成，跳过到期处理`);
	            return;
	        }

	        const now = Date.now();
	        const timeUntilExpiry = process.expireAt - now;

	        if (timeUntilExpiry <= 0) {
	            // 已过期，直接处理
	            await this.executeProcessExpiry(process, client);
	        } else {
	            // 设置定时器
	            setTimeout(async () => {
	                // 在执行到期处理前再次检查流程状态
	                const currentProcess = await ProcessModel.getProcessById(process.id);
	                if (currentProcess && currentProcess.status === 'completed') {
	                    logTime(`流程 ${process.id} 已完成，跳过到期处理`);
	                    return;
	                }
	                await this.executeProcessExpiry(process, client);
	            }, timeUntilExpiry);

	            logTime(`已调度流程 ${process.id} 的到期处理，将在 ${Math.ceil(timeUntilExpiry / 1000)} 秒后执行`);
	        }
	    } catch (error) {
	        logTime(`调度流程失败: ${error.message}`, true);
	    }
    }

    // 执行处罚到期操作
    async executePunishmentExpiry(client, punishment) {
	    try {
	        await PunishmentService.handleExpiry(client, punishment);
	    } catch (error) {
	        logTime(`处理处罚到期失败: ${error.message}`, true);
	    }
    }

    // 执行流程到期操作
    async executeProcessExpiry(process, client) {
	    try {
	        // 只处理议事相关的流程
	        if (!process.type.startsWith('court_') && !process.type.startsWith('appeal')) {
	            return;
	        }

	        // 从process.details中获取原始消息信息
	        let details = {};
	        try {
	            details = typeof process.details === 'string' ?
	                JSON.parse(process.details) :
	                (process.details || {});
	        } catch (error) {
	            logTime(`解析流程详情失败: ${error.message}`, true);
	            return;
	        }

	        if (!details.embed) {
	            logTime(`无法获取流程详情: ${process.id}`, true);
	            return;
	        }

	        try {
	            // 获取主服务器配置
	            const guildIds = client.guildManager.getGuildIds();
	            const mainGuildConfig = guildIds
	                .map(id => client.guildManager.getGuildConfig(id))
	                .find(config => config?.serverType === 'Main server');

	            if (!mainGuildConfig?.courtSystem?.enabled) {
	                logTime('主服务器未启用议事系统', true);
	                return;
	            }

	            // 获取原始消息
	            const courtChannel = await client.channels.fetch(mainGuildConfig.courtSystem.courtChannelId);
	            if (!courtChannel) {
	                logTime(`无法获取议事频道: ${mainGuildConfig.courtSystem.courtChannelId}`, true);
	                return;
	            }

	            const message = await courtChannel.messages.fetch(process.messageId);
	            if (message) {
	                // 更新消息
	                const embed = message.embeds[0];
	                await message.edit({
	                    embeds: [{
	                        ...embed.data,
	                        description: `${embed.description}\n\n❌ 议事已过期，未达到所需支持人数`,
	                    }],
	                    components: [], // 移除支持按钮
	                });
                    logTime(`更新过期消息成功: ${process.id}`);
	            }
	        } catch (error) {
	            logTime(`更新过期消息失败: ${error.message}`, true);
	        }

	        // 更新流程状态
	        await ProcessModel.updateStatus(process.id, 'completed', {
	            result: 'cancelled',
	            reason: '议事流程已过期，未达到所需支持人数',
	        });

	    } catch (error) {
	        logTime(`处理议事流程到期失败: ${error.message}`, true);
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
	        logTime(`服务器 ${guildId} 的定时任务执行失败: ${error.message}`, true);
	    }
    }


    // 停止所有任务
    stopAll() {
	    const taskCount = this.timers.size;

	    for (const timer of this.timers.values()) {
	        clearInterval(timer);
	    }

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
}

// 创建全局单例
export const globalTaskScheduler = new TaskScheduler();