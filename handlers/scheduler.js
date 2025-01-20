import { logTime } from '../utils/logger.js';
import { analyzeThreads } from '../services/analyzers.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { dbManager } from '../db/manager.js';
import { PunishmentModel, ProcessModel } from '../db/models/index.js';
import PunishmentService from '../services/punishment_service.js';

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
     * 注册子区分析任务
     * @param {Client} client - Discord客户端实例
     */
    registerAnalysisTasks(client) {
        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            // 只为启用了分析的服务器注册任务
            if (guildConfig.automation?.analysis) {
                this.scheduleAnalysis(client, guildId, guildConfig);
            }
        }
    }

    /**
     * 注册处罚系统相关任务
     * @param {Client} client - Discord客户端实例
     */
    registerPunishmentTasks(client) {
        // 处罚到期检查（每30秒）
        this.addTask('punishmentCheck', 30 * 1000, async () => {
            try {
                const expiredPunishments = await PunishmentModel.handleExpiredPunishments();
                for (const punishment of expiredPunishments) {
                    // 执行处罚到期操作
                    await this.executePunishmentExpiry(client, punishment);
                }
            } catch (error) {
                logTime(`处理过期处罚失败: ${error.message}`, true);
            }
        });

        // 投票状态更新（每3分钟）
        this.addTask('voteUpdate', 3 * 60 * 1000, async () => {
            try {
                const expiredProcesses = await ProcessModel.handleExpiredProcesses();
                for (const process of expiredProcesses) {
                    // 执行流程到期操作
                    await this.executeProcessExpiry(client, process);
                }
            } catch (error) {
                logTime(`处理过期流程失败: ${error.message}`, true);
            }
        });
    }

    /**
     * 注册数据库相关任务
     */
    registerDatabaseTasks() {
        // 每天6点执行数据库备份
        const backupInterval = 24 * 60 * 60 * 1000; // 24小时
        const now = new Date();
        const nextBackup = new Date(now);
        nextBackup.setHours(6, 0, 0, 0);
        if (nextBackup <= now) {
            nextBackup.setDate(nextBackup.getDate() + 1);
        }
        
        const timeUntilBackup = nextBackup - now;
        
        // 设置首次备份的定时器
        setTimeout(() => {
            this.executeDatabaseBackup();
            // 设置后续每24小时执行一次的定时器
            this.addTask('databaseBackup', backupInterval, () => this.executeDatabaseBackup());
        }, timeUntilBackup);
        
        logTime(`数据库备份计划已设置，首次备份将在 ${nextBackup.toLocaleString()} 执行`);
    }

    /**
     * 执行数据库备份
     */
    async executeDatabaseBackup() {
        try {
            await dbManager.backup();
            logTime('数据库备份完成');
        } catch (error) {
            logTime(`数据库备份失败: ${error.message}`, true);
        }
    }

    /**
     * 添加定时任务
     * @param {string} taskId - 任务ID
     * @param {number} interval - 任务间隔（毫秒）
     * @param {Function} task - 任务函数
     */
    addTask(taskId, interval, task) {
        if (this.timers.has(taskId)) {
            clearInterval(this.timers.get(taskId));
        }

        const timer = setInterval(async () => {
            try {
                await task();
            } catch (error) {
                logTime(`任务 ${taskId} 执行失败: ${error.message}`, true);
            }
        }, interval);

        this.timers.set(taskId, timer);
        this.tasks.set(taskId, { interval, task });
        logTime(`已添加定时任务: ${taskId}, 间隔: ${interval}ms`);
    }

    /**
     * 调度子区分析任务
     * @param {Client} client - Discord客户端实例
     * @param {string} guildId - 服务器ID
     * @param {Object} guildConfig - 服务器配置
     */
    scheduleAnalysis(client, guildId, guildConfig) {
        const scheduleNextRun = () => {
            // 清除已存在的定时器
            if (this.timers.has(`analysis_${guildId}`)) {
                clearTimeout(this.timers.get(`analysis_${guildId}`));
            }

            // 计算下次执行时间
            const now = new Date();
            const nextRun = new Date(now);
            
            if (nextRun.getMinutes() >= 30) {
                nextRun.setHours(nextRun.getHours() + 1);
                nextRun.setMinutes(0);
            } else {
                nextRun.setMinutes(30);
            }
            nextRun.setSeconds(0);
            nextRun.setMilliseconds(0);
            
            const timeUntilNextRun = nextRun - now;
            
            // 构建任务描述
            const tasks = ['分析'];
            if (guildConfig.automation?.cleanup?.enabled) {
                tasks.push('清理');
            }
            
            // 设置新的定时器
            const timer = setTimeout(async () => {
                try {
                    await this.runScheduledTasks(client, guildConfig, guildId);
                } catch (error) {
                    logTime(`服务器 ${guildId} 定时任务执行出错: ${error}`, true);
                } finally {
                    scheduleNextRun();
                }
            }, timeUntilNextRun);

            this.timers.set(`analysis_${guildId}`, timer);
        };

        scheduleNextRun();
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
        // TODO: 实现流程到期的具体操作
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