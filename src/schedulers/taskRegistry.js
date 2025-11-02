import schedule from 'node-schedule';
import { dbManager } from '../db/dbManager.js';
import { BlacklistService } from '../services/blacklistService.js';
import { carouselServiceManager } from '../services/carouselService.js';
import { monitorService } from '../services/monitorService.js';
import { opinionMailboxService } from '../services/opinionMailboxService.js';
import { executeThreadManagement } from '../services/threadAnalyzer.js';
import { cleanupCachedThreadsSequentially } from '../services/threadCleaner.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';
import { punishmentConfirmationStore } from '../utils/punishmentConfirmationHelper.js';

/**
 * 任务注册器 - 负责注册各种业务定时任务
 */
export class TaskRegistry {
    constructor(taskScheduler) {
        this.taskScheduler = taskScheduler;
    }

    /**
     * 注册所有业务任务
     * @param {Object} client - Discord客户端
     */
    registerAll(client) {
        this.registerDatabaseTasks(client);
        this.registerAnalysisTasks(client);
        this.registerMonitorTasks(client);
        this.registerOpinionMailboxTasks(client);
        this.registerCachedThreadCleanupTasks(client);
        this.registerPunishmentConfirmationTasks(client);
        this.registerChannelCarouselTasks(client);
    }

    /**
     * 注册数据库相关任务
     * @param {Object} client - Discord客户端
     */
    registerDatabaseTasks(client) {
        // 数据库备份任务 - 每天早上6点执行
        this.taskScheduler.addDailyTask({
            taskId: 'databaseBackup',
            hour: 6,
            minute: 0,
            task: async () => {
                await dbManager.backup();
                logTime('[定时任务] 数据库备份完成');
            }
        });

        // 黑名单更新任务 - 每天早上4点执行
        this.taskScheduler.addDailyTask({
            taskId: 'blacklistUpdate',
            hour: 4,
            minute: 0,
            task: async () => {
                const result = await BlacklistService.updateBlacklistFromPunishments(client);
                if (result.success) {
                    logTime(`[定时任务] 黑名单更新完成，新增 ${result.addedCount} 个用户，总计 ${result.totalCount} 个用户`);
                }
            }
        });

        // 重新加载所有调度器的定时任务 - 每天凌晨3点执行
        this.taskScheduler.addDailyTask({
            taskId: 'reloadSchedulers',
            hour: 3,
            minute: 0,
            task: async () => {
                // 清理现有定时器
                this.taskScheduler.getScheduler('process')?.cleanup();
                this.taskScheduler.getScheduler('punishment')?.cleanup();

                // 重新初始化
                await this.taskScheduler.getScheduler('process')?.initialize(client);
                await this.taskScheduler.getScheduler('punishment')?.initialize(client);

                logTime('[定时任务] 所有流程和处罚定时器已重新加载完成');
            }
        });
    }

    /**
     * 注册子区分析和清理任务
     * @param {Object} client - Discord客户端
     */
    registerAnalysisTasks(client) {
        // 获取所有启用了子区管理的服务器
        const managedGuilds = Array.from(client.guildManager.guilds.entries())
            .filter(([_, config]) => config.automation?.mode !== 'disabled')
            .map(([guildId]) => guildId);

        if (managedGuilds.length === 0) return;

        // 为每个服务器设置错开的执行时间
        managedGuilds.forEach((guildId, index) => {
            const guildConfig = client.guildManager.guilds.get(guildId);

            // 创建每小时的15分和45分执行的规则
            const rule = new schedule.RecurrenceRule();
            rule.minute = [15, 45];
            rule.second = 0 + ((index * 10) % 60);

            this.taskScheduler.addCustomTask({
                taskId: `thread_management_${guildId}`,
                rule: rule,
                description: `服务器 ${guildId} 的子区管理任务，每小时的15分和45分执行`,
                task: () => this._executeThreadManagement(client, guildConfig, guildId)
            });
        });
    }

    /**
     * 执行子区管理任务
     * @private
     */
    async _executeThreadManagement(client, guildConfig, guildId) {
        await globalRequestQueue.add(async () => {
            const guild = await client.guilds.fetch(guildId);
            const activeThreads = await guild.channels.fetchActiveThreads();
            await executeThreadManagement(client, guildConfig, guildId, activeThreads);
        }, 0);

        logTime(`[定时任务] 完成服务器 ${guildId} 的子区管理任务`);
    }

    /**
     * 注册监控任务
     * @param {Object} client - Discord客户端
     */
    registerMonitorTasks(client) {
        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            if (!guildConfig.monitor?.enabled) continue;

            // 状态监控任务 - 每分钟执行
            this.taskScheduler.addTask({
                taskId: `monitor_${guildId}`,
                interval: 60 * 1000, // 1分钟
                task: () => monitorService.updateStatusMessage(client, guildId),
                runImmediately: true
            });

            // 角色监控任务
            if (guildConfig.monitor?.roleMonitorCategoryId && guildConfig.monitor?.monitoredRoleId) {
                // 角色监控任务 - 每15分钟执行
                this.taskScheduler.addTask({
                    taskId: `role_monitor_${guildId}`,
                    interval: 15 * 60 * 1000, // 15分钟
                    task: () => monitorService.monitorRoleMembers(client, guildId),
                    runImmediately: true
                });
            }
        }
    }

    /**
     * 注册意见信箱维护任务
     * @param {Object} client - Discord客户端
     */
    registerOpinionMailboxTasks(client) {
        // 每5分钟执行的固定间隔任务
        this.taskScheduler.addTask({
            taskId: 'opinion_mailbox_maintenance',
            interval: 5 * 60 * 1000, // 5分钟
            task: () => opinionMailboxService.maintainAllMailboxMessages(client)
        });
    }

    /**
     * 注册缓存子区清理任务
     * @param {Object} client - Discord客户端
     */
    registerCachedThreadCleanupTasks(client) {
        const managedGuilds = Array.from(client.guildManager.guilds.entries())
            .filter(([_, config]) => config.automation?.mode !== 'disabled')
            .map(([guildId]) => guildId);

        if (managedGuilds.length === 0) {
            return;
        }

        // 每30分钟执行的固定间隔任务
        this.taskScheduler.addTask({
            taskId: 'cached_thread_cleanup',
            interval: 30 * 60 * 1000, // 30分钟
            task: () => this._executeCachedThreadCleanup(client, managedGuilds)
        });
    }

    /**
     * 执行缓存子区清理
     * @private
     */
    async _executeCachedThreadCleanup(client, managedGuilds) {
        logTime('[定时任务] 开始执行缓存子区清理任务');

        for (const guildId of managedGuilds) {
            await globalRequestQueue.add(async () => {
                const guild = await client.guilds.fetch(guildId);
                const activeThreads = await guild.channels.fetchActiveThreads();

                const activeThreadsMap = new Map();
                activeThreads.threads.forEach(thread => {
                    activeThreadsMap.set(thread.id, thread);
                });

                const cleanupResults = await cleanupCachedThreadsSequentially(client, guildId, activeThreadsMap);
                if (cleanupResults.qualifiedThreads > 0) {
                    logTime(`[定时任务] 服务器 ${guildId} 缓存子区清理完成 - 符合条件: ${cleanupResults.qualifiedThreads}, 已清理: ${cleanupResults.cleanedThreads}`);
                }
            }, 0);
        }
    }

    /**
     * 注册处罚确认清理任务
     * @param {Object} client - Discord客户端
     */
    registerPunishmentConfirmationTasks(client) {
        // 每小时清理一次过期的确认数据（保险机制，主要依赖 setTimeout）
        this.taskScheduler.addTask({
            taskId: 'cleanup_expired_punishment_confirmations',
            interval: 60 * 60 * 1000, // 1小时
            task: () => punishmentConfirmationStore.cleanupExpired(client)
        });
    }

    /**
     * 注册频道轮播任务
     * @param {Object} client - Discord客户端
     */
    async registerChannelCarouselTasks(client) {
        // 加载并启动所有已配置的频道轮播
        const channelCarousel = carouselServiceManager.getChannelCarousel();
        const config = await channelCarousel.loadConfig();

        if (!config.channelCarousels) {
            return;
        }

        let totalCarousels = 0;
        for (const [guildId, channelsConfig] of Object.entries(config.channelCarousels)) {
            for (const [channelId, carouselConfig] of Object.entries(channelsConfig)) {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (channel && carouselConfig.items && carouselConfig.items.length > 0) {
                        await channelCarousel.startChannelCarousel(channel, guildId, channelId);
                        totalCarousels++;
                    }
                } catch (error) {
                    logTime(`[频道轮播] 无法加载频道 ${channelId} 的轮播: ${error.message}`, true);
                }
            }
        }

        if (totalCarousels > 0) {
            logTime(`[频道轮播] 已启动 ${totalCarousels} 个频道轮播`);
        }
    }
}
