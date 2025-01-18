import { logTime } from '../utils/logger.js';
import { analyzeThreads } from '../utils/analyzers.js';
import { globalRequestQueue, globalRateLimiter } from '../utils/concurrency.js';

/**
 * 定时任务管理器
 * 用于集中管理所有的定时任务，包括：
 * - 子区分析和清理
 * - 处罚到期检查
 * - 投票状态更新
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
        // 处罚到期检查（每5分钟）
        this.addTask('punishmentCheck', 5 * 60 * 1000, async () => {
            await this.checkPunishments(client);
        });

        // 投票状态更新（每3分钟）
        this.addTask('voteUpdate', 3 * 60 * 1000, async () => {
            await this.updateVoteStatus(client);
        });
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
            
            logTime(`服务器 ${guildId} 的下次${tasks.join('和')}将在 ${nextRun.toLocaleString()} 执行`);
            
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
                await globalRateLimiter.withRateLimit(async () => {
                    if (guildConfig.automation?.analysis) {
                        await analyzeThreads(client, guildConfig, guildId);
                    }

                    if (guildConfig.automation?.cleanup?.enabled) {
                        await analyzeThreads(client, guildConfig, guildId, {
                            clean: true,
                            threshold: guildConfig.automation.cleanup.threshold || 960
                        });
                    }
                });
            }, 0);
        } catch (error) {
            logTime(`服务器 ${guildId} 的定时任务执行失败: ${error.message}`, true);
        }
    }

    /**
     * 检查处罚到期状态
     * @param {Client} client - Discord客户端实例
     */
    async checkPunishments(client) {
        // TODO: 实现处罚到期检查逻辑
    }

    /**
     * 更新投票状态
     * @param {Client} client - Discord客户端实例
     */
    async updateVoteStatus(client) {
        // TODO: 实现投票状态更新逻辑
    }

    /**
     * 停止所有任务
     */
    stopAll() {
        for (const [taskId, timer] of this.timers) {
            clearInterval(timer);
            logTime(`已停止任务: ${taskId}`);
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