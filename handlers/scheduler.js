import { logTime } from '../utils/logger.js';
import { analyzeThreads } from '../services/analyzers.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { dbManager } from '../db/manager.js';
import { PunishmentModel, ProcessModel } from '../db/models/index.js';
import PunishmentService from '../services/punishment_service.js';

/**
 * 时间单位转换为毫秒
 * @private
 */
const TIME_UNITS = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000
};

/**
 * 格式化时间间隔
 * @private
 */
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
        this.tasks = new Map();  // 存储任务配置
        this.isInitialized = false;
    }

    /**
     * 初始化任务调度器
     * @param {Client} client - Discord客户端实例
     */
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
        if (this.timers.has(taskId)) {
            clearInterval(this.timers.get(taskId));
            clearTimeout(this.timers.get(`${taskId}_initial`));
        }

        const scheduleTask = () => {
            const timer = setInterval(async () => {
                try {
                    await task();
                } catch (error) {
                    logTime(`任务 ${taskId} 执行失败: ${error.message}`, true);
                }
            }, interval);

            this.timers.set(taskId, timer);
            this.tasks.set(taskId, { interval, task });
        };

        // 构建任务信息日志
        const taskInfo = [
            `定时任务: ${taskId}`,
            `执行间隔: ${formatInterval(interval)}`
        ];

        if (startAt) {
            const now = new Date();
            const delay = startAt - now;
            if (delay > 0) {
                taskInfo.push(`首次执行: ${startAt.toLocaleString()}`);
                const initialTimer = setTimeout(() => {
                    scheduleTask();
                    task(); // 在预定时间执行一次
                }, delay);
                this.timers.set(`${taskId}_initial`, initialTimer);
            }
        } else if (runImmediately) {
            taskInfo.push('立即执行: 是');
        }

        // 输出统一格式的日志
        logTime(taskInfo.join(' | '));

        scheduleTask();
        if (runImmediately) {
            task().catch(error => {
                logTime(`任务 ${taskId} 初始执行失败: ${error.message}`, true);
            });
        }
    }

    /**
     * 注册子区分析任务
     * @param {Client} client - Discord客户端实例
     */
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
                        await this.runScheduledTasks(client, guildConfig, guildId);
                    } catch (error) {
                        logTime(`服务器 ${guildId} 定时任务执行出错: ${error}`, true);
                    }
                }
            });
        }
    }

    /**
     * 注册处罚系统相关任务
     * @param {Client} client - Discord客户端实例
     */
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
            }
        });

        // 投票状态更新
        this.addTask({
            taskId: 'voteUpdate',
            interval: 30 * TIME_UNITS.SECOND,
            runImmediately: true,
            task: async () => {
                try {
                    const expiredProcesses = await ProcessModel.handleExpiredProcesses();
                    for (const process of expiredProcesses) {
                        await this.executeProcessExpiry(client, process);
                    }
                } catch (error) {
                    logTime(`处理过期流程失败: ${error.message}`, true);
                }
            }
        });
    }

    /**
     * 注册数据库相关任务
     */
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
            }
        });
    }

    /**
     * 执行子区分析任务
     * @param {Client} client - Discord客户端实例
     * @param {Object} guildConfig - 服务器配置
     * @param {string} guildId - 服务器ID
     */
    async runScheduledTasks(client, guildConfig, guildId) {
        try {
            await globalRequestQueue.add(async () => {
                if (guildConfig.automation?.analysis) {
                    await analyzeThreads(client, guildConfig, guildId);
                }

                if (guildConfig.automation?.cleanup?.enabled) {
                    await analyzeThreads(client, guildConfig, guildId, {
                        clean: true,
                        threshold: guildConfig.automation.cleanup.threshold || 960
                    });
                }
            }, 0);
        } catch (error) {
            logTime(`服务器 ${guildId} 的定时任务执行失败: ${error.message}`, true);
        }
    }

    /**
     * 执行处罚到期操作
     * @private
     */
    async executePunishmentExpiry(client, punishment) {
        try {
            await PunishmentService.handleExpiry(client, punishment);
        } catch (error) {
            logTime(`处理处罚到期失败: ${error.message}`, true);
        }
    }

    /**
     * 执行流程到期操作
     * @private
     */
    async executeProcessExpiry(client, process) {
        try {
            // 只处理议事相关的流程
            if (!process.type.startsWith('court_')) {
                return;
            }

            // 从process.details中获取原始消息信息
            const details = process.details ? JSON.parse(process.details) : {};
            if (!details.embed) {
                logTime(`无法获取流程详情: ${process.id}`, true);
                return;
            }

            try {
                // 获取服务器配置
                const guildId = process.targetId.split('_')[0];
                const guildConfig = client.guildManager.getGuildConfig(guildId);
                if (!guildConfig?.courtSystem?.enabled) {
                    logTime(`服务器 ${guildId} 未启用议事系统`, true);
                    return;
                }

                // 获取原始消息
                const courtChannel = await client.channels.fetch(guildConfig.courtSystem.courtChannelId);
                if (!courtChannel) {
                    logTime(`无法获取议事频道: ${guildConfig.courtSystem.courtChannelId}`, true);
                    return;
                }

                const message = await courtChannel.messages.fetch(process.messageId);
                if (message) {
                    // 更新消息
                    const embed = message.embeds[0];
                    await message.edit({
                        embeds: [{
                            ...embed.data,
                            description: `${embed.description}\n\n❌ 议事已过期，未达到所需支持人数`
                        }],
                        components: [] // 移除支持按钮
                    });
                }
            } catch (error) {
                logTime(`更新过期消息失败: ${error.message}`, true);
            }

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'completed', {
                result: 'cancelled',
                reason: '议事流程已过期，未达到所需支持人数'
            });

        } catch (error) {
            logTime(`处理议事流程到期失败: ${error.message}`, true);
        }
    }

    /**
     * 停止所有任务
     */
    stopAll() {
        let stoppedCount = 0;
        for (const [taskId, timer] of this.timers) {
            clearInterval(timer);
            stoppedCount++;
        }
        if (stoppedCount > 0) {
            logTime(`已停止 ${stoppedCount} 个定时任务`);
        }
        this.timers.clear();
        this.isInitialized = false;
    }

    /**
     * 重启所有任务
     * @param {Client} client - Discord客户端实例
     */
    restart(client) {
        this.stopAll();
        this.initialize(client);
    }
}

// 创建全局单例
export const globalTaskScheduler = new TaskScheduler(); 