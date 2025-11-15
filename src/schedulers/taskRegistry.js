import schedule from 'node-schedule';
import { dbManager } from '../sqlite/dbManager.js';
import { carouselServiceManager } from '../services/carousel/carouselManager.js';
import { monitorService } from '../services/system/monitorService.js';
import { opinionMailboxService } from '../services/user/opinionMailboxService.js';
import { executeThreadManagement } from '../services/thread/threadAnalyzer.js';
import { cleanupCachedThreadsSequentially } from '../services/thread/threadCleaner.js';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';
import { punishmentConfirmationStore } from '../utils/punishmentConfirmationHelper.js';
import { pgSyncScheduler } from './pgSyncScheduler.js';

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
        this.registerAutoDeleteChannelCleanupTasks(client);
        this.registerPgSyncTasks(client);
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

    /**
     * 注册自动删除频道清理任务
     * @param {Object} client - Discord客户端
     */
    registerAutoDeleteChannelCleanupTasks(client) {
        // 每5分钟执行的固定间隔任务
        this.taskScheduler.addTask({
            taskId: 'auto_delete_channel_cleanup',
            interval: 5 * 60 * 1000, // 5分钟
            task: () => this._executeAutoDeleteChannelCleanup(client)
        });
    }

    /**
     * 执行自动删除频道清理
     * @private
     */
    async _executeAutoDeleteChannelCleanup(client) {
        let totalDeleted = 0;

        for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
            const autoDeleteChannels = guildConfig.autoDeleteChannels || [];
            if (autoDeleteChannels.length === 0) continue;

            for (const channelId of autoDeleteChannels) {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel) continue;

                    // 获取最近100条消息
                    const messages = await channel.messages.fetch({ limit: 100 });

                    // 过滤需要删除的消息, 保守化处理
                    const messagesToDelete = messages.filter(msg => {
                        // 1. 保留bot消息
                        if (msg.author.bot) return false;

                        // 2. 保留置顶消息
                        if (msg.pinned) return false;

                        // 3. 只删除10分钟内的消息
                        const messageAge = Date.now() - msg.createdTimestamp;
                        if (messageAge > 10 * 60 * 1000) return false;

                        // 4. 如果member不存在，不删除
                        const member = msg.member;
                        if (!member) return false;

                        // 5. 检查是否是管理员（如果检查失败则不删除）
                        try {
                            const isAdmin = member.roles.cache.some(role =>
                                guildConfig.AdministratorRoleIds?.includes(role.id) ||
                                guildConfig.ModeratorRoleIds?.includes(role.id)
                            );
                            // 只删除非管理员的消息
                            return !isAdmin;
                        } catch (error) {
                            // 权限检查失败，保守不删除
                            return false;
                        }
                    });

                    if (messagesToDelete.size === 0) continue;

                    // 删除消息
                    for (const msg of messagesToDelete.values()) {
                        try {
                            await msg.delete();
                            totalDeleted++;
                            await delay(1000);
                        } catch (error) {
                            // 静默处理单条消息删除失败
                        }
                    }
                } catch (error) {
                    logTime(`[定时任务] 清理频道 ${channelId} 消息失败: ${error.message}`, true);
                }
            }
        }

        if (totalDeleted > 0) {
            logTime(`[定时任务] 自动删除频道清理完成，共删除 ${totalDeleted} 条消息`);
        }
    }

    /**
     * 注册PostgreSQL同步任务
     * @param {Object} client - Discord客户端
     */
    async registerPgSyncTasks(client) {
        // 初始化调度器
        await pgSyncScheduler.initialize(client);

        // 创作者身份组同步 - 每小时
        this.taskScheduler.addTask({
            taskId: 'pg_user_roles_sync',
            interval: 60 * 60 * 1000, // 1小时
            task: () => pgSyncScheduler.syncCreatorRoles(client),
            startAt: new Date(Date.now() + 30 * 1000), // 延迟30秒首次执行，等待成员缓存初始化
            runImmediately: false
        });

        // 帖子成员同步 - 每5分钟
        this.taskScheduler.addTask({
            taskId: 'pg_post_members_sync',
            interval: 5 * 60 * 1000, // 5分钟
            task: () => pgSyncScheduler.processPostMembersBatch(client),
            runImmediately: false // 延迟启动，等系统稳定
        });

        logTime('[定时任务] PostgreSQL同步任务已注册');
    }
}
