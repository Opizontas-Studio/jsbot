import { pgManager } from '../../pg/pgManager.js';
import { PgSyncStateModel } from '../../sqlite/models/pgSyncStateModel.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { delay } from '../../utils/concurrency.js';
import { autoGrantCreatorRole } from '../role/creatorRoleService.js';

/**
 * 帖子成员同步服务
 * 渐进式同步帖子成员关系到 post_members 表
 */
class PostMembersSyncService {
    /**
     * @param {Object} options - 配置选项
     * @param {number} options.batchSize - 每批次处理的帖子数量
     * @param {number} options.delayBetweenThreads - 每个帖子处理后的延迟毫秒数
     * @param {number} options.cacheTimeout - 缓存过期时间毫秒数
     */
    constructor(options = {}) {
        this.isProcessing = false;
        this.processedCount = 0;
        this.cachedMembersData = new Map(); // 缓存从 threadCleaner 获取的数据
        
        // 同步速率相关参数
        this.batchSize = options.batchSize ?? 100; // 每批次处理的帖子数量
        this.delayBetweenThreads = options.delayBetweenThreads ?? 100; // 每个帖子处理后的延迟(ms)
        this.cacheTimeout = options.cacheTimeout ?? (30 * 60 * 1000); // 缓存过期时间（默认30分钟）
    }

    /**
     * 处理一批帖子
     */
    async processBatch(client) {
        if (this.isProcessing) {
            logTime('[帖子成员同步] 上一批次仍在处理中，跳过');
            return;
        }

        this.isProcessing = true;

        try {
            return await ErrorHandler.handleService(
                async () => {
                    if (!pgManager.getConnectionStatus()) {
                        logTime('[帖子成员同步] PostgreSQL未连接，跳过同步');
                        return { success: false };
                    }

                    // 获取待同步的帖子列表
                    const threadIds = await PgSyncStateModel.getThreadsToSync(this.batchSize);
                    
                    if (threadIds.length === 0) {
                        // 所有帖子都已更新，清理过期错误并重置
                        await PgSyncStateModel.cleanupErrors();
                        return { processed: 0, cached: 0 };
                    }

                    let processed = 0;
                    let cached = 0;

                    for (const threadId of threadIds) {
                        try {
                            // 检查是否有缓存数据
                            const cachedData = this.getCachedMembersData(threadId);
                            if (cachedData) {
                                await this._syncThreadMembers(threadId, cachedData);
                                cached++;
                            } else {
                                // 需要实际fetch
                                await this._fetchAndSyncThread(client, threadId);
                            }
                            processed++;
                            
                            // 控制速率，避免过快
                            await delay(this.delayBetweenThreads);
                        } catch (error) {
                            logTime(`[帖子成员同步] 帖子 ${threadId} 同步失败: ${error.message}`, true);
                            await PgSyncStateModel.updateThreadState(threadId, {
                                success: false,
                                error: error.message
                            });
                        }
                    }

                    this.processedCount += processed;
                    logTime(`[帖子成员同步] 完成批次 - 处理: ${processed}, 缓存命中: ${cached}, 总计: ${this.processedCount}`);
                    
                    return { processed, cached };
                },
                '处理帖子成员同步批次'
            );
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Fetch并同步单个帖子
     * @private
     */
    async _fetchAndSyncThread(client, threadId) {
        return await ErrorHandler.handleService(
            async () => {
                const thread = await client.channels.fetch(threadId);
                if (!thread || !thread.isThread()) {
                    throw new Error('帖子不存在或不是thread类型');
                }

                const members = await thread.members.fetch();
                await this._syncThreadMembers(threadId, members, client);
            },
            `Fetch并同步帖子 ${threadId}`,
            { throwOnError: true }
        );
    }

    /**
     * 同步帖子成员数据到数据库
     * @private
     */
    async _syncThreadMembers(threadId, members, client = null) {
        return await ErrorHandler.handleService(
            async () => {
                const models = pgManager.getModels();
                
                // 获取帖子信息
                const post = await models.PostsMain.findOne({
                    where: { thread_id: threadId },
                    raw: true
                });

                if (!post) {
                    throw new Error('帖子在posts_main表中不存在');
                }

                const threadOwnerId = post.author_id;
                const currentMembers = Array.from(members.values());

                // 获取数据库中现有的成员关系
                const dbMembers = await models.PostMembers.findAll({
                    where: { thread_id: threadId },
                    raw: true
                });

                const dbUserIds = new Set(dbMembers.map(m => m.user_id));
                const currentUserIds = new Set(currentMembers.map(m => m.user.id));

                await pgManager.transaction(async (t) => {
                    // 处理新成员和返回的成员
                    for (const member of currentMembers) {
                        const userId = member.user.id;
                        const isOwner = userId === threadOwnerId;
                        const existingMember = dbMembers.find(m => m.user_id === userId);

                        if (existingMember) {
                            // 成员已存在，更新状态
                            if (existingMember.is_leave) {
                                // 成员返回了
                                await models.PostMembers.update({
                                    last_join_at: member.joinedTimestamp ? new Date(member.joinedTimestamp) : new Date(),
                                    is_leave: false,
                                    last_leave_at: null
                                }, {
                                    where: { user_id: userId, thread_id: threadId },
                                    transaction: t
                                });
                            }
                            // 其他情况保持不变
                        } else {
                            // 新成员
                            const joinedAt = member.joinedTimestamp ? new Date(member.joinedTimestamp) : new Date();
                            await models.PostMembers.create({
                                user_id: userId,
                                thread_id: threadId,
                                is_thread_owner: isOwner,
                                first_join_at: joinedAt,
                                last_join_at: joinedAt,
                                is_leave: false,
                                message_count: 0
                            }, { transaction: t });
                        }
                    }

                    // 处理离开的成员
                    const leftMembers = dbMembers.filter(
                        m => !currentUserIds.has(m.user_id) && !m.is_leave
                    );

                    for (const member of leftMembers) {
                        await models.PostMembers.update({
                            is_leave: true,
                            last_leave_at: new Date()
                        }, {
                            where: { user_id: member.user_id, thread_id: threadId },
                            transaction: t
                        });
                    }
                });

                // 更新同步状态
                await PgSyncStateModel.updateThreadState(threadId, {
                    memberCount: currentMembers.length,
                    success: true
                });

                // 尝试自动为帖子作者发放创作者身份组
                if (client) {
                    await ErrorHandler.handleSilent(
                        async () => {
                            const result = await autoGrantCreatorRole(client, threadId, threadOwnerId);
                            if (result.granted) {
                                logTime(
                                    `[自动发放创作者] 成功为用户 ${threadOwnerId} 发放创作者身份组（帖子 ${threadId}）`
                                );
                            } else if (result.reason && 
                                       !result.reason.includes('已有创作者身份组') && 
                                       !result.reason.includes('反应数不足') &&
                                       !result.reason.includes('限速') &&
                                       !result.reason.includes('处理过程中出现错误')) {
                                // 只记录非常规失败原因（排除：已有身份组、反应数不足、限速、临时错误）
                                logTime(
                                    `[自动发放创作者] 帖子 ${threadId} 的作者 ${threadOwnerId} 暂不发放：${result.reason}`
                                );
                            }
                        },
                        `自动发放创作者身份组检查（帖子 ${threadId}）`
                    );
                }
            },
            `同步帖子成员 ${threadId}`,
            { throwOnError: true }
        );
    }

    /**
     * 接收来自 threadCleaner 的成员数据
     * @param {string} threadId - 帖子ID
     * @param {Collection} members - 成员集合
     * @param {Object} client - Discord客户端（可选）
     */
    async receiveMemberData(threadId, members, client = null) {
        await ErrorHandler.handleSilent(
            async () => {
                this.cachedMembersData.set(threadId, {
                    members,
                    timestamp: Date.now()
                });

                // 直接使用缓存数据同步
                await this._syncThreadMembers(threadId, members, client);
                
                // 清理过期缓存
                this._cleanupExpiredCache();
            },
            `接收并缓存帖子 ${threadId} 的成员数据`
        );
    }

    /**
     * 获取缓存的成员数据
     * @private
     */
    getCachedMembersData(threadId) {
        const cached = this.cachedMembersData.get(threadId);
        if (!cached) return null;

        const age = Date.now() - cached.timestamp;
        if (age > this.cacheTimeout) {
            this.cachedMembersData.delete(threadId);
            return null;
        }

        return cached.members;
    }

    /**
     * 清理过期的缓存
     * @private
     */
    _cleanupExpiredCache() {
        const now = Date.now();
        for (const [threadId, data] of this.cachedMembersData.entries()) {
            if (now - data.timestamp > this.cacheTimeout) {
                this.cachedMembersData.delete(threadId);
            }
        }
    }

    /**
     * 初始化帖子列表
     */
    async initializeFromPostsMain() {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    logTime('[帖子成员同步] PostgreSQL未连接，跳过初始化');
                    return;
                }

                const models = pgManager.getModels();
                const posts = await models.PostsMain.findAll({
                    attributes: ['thread_id', 'last_active_at'],
                    raw: true
                });

                // 根据活跃时间设置优先级
                const now = Date.now();
                const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
                const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

                const threadsByPriority = {
                    high: [],
                    medium: [],
                    low: []
                };

                for (const post of posts) {
                    const lastActive = new Date(post.last_active_at).getTime();
                    let priority;
                    
                    if (lastActive >= threeDaysAgo) {
                        priority = 'high';
                    } else if (lastActive >= sevenDaysAgo) {
                        priority = 'medium';
                    } else {
                        priority = 'low';
                    }

                    threadsByPriority[priority].push(post.thread_id);
                }

                // 批量初始化
                for (const [priority, threadIds] of Object.entries(threadsByPriority)) {
                    if (threadIds.length > 0) {
                        await PgSyncStateModel.initializeThreads(threadIds, priority);
                    }
                }

                logTime(`[帖子成员同步] 初始化完成 - 总计: ${posts.length} (高: ${threadsByPriority.high.length}, 中: ${threadsByPriority.medium.length}, 低: ${threadsByPriority.low.length})`);
            },
            '从posts_main初始化帖子列表'
        );
    }

    /**
     * 获取同步统计
     */
    async getStats() {
        return await PgSyncStateModel.getStats();
    }
}

export const postMembersSyncService = new PostMembersSyncService();
export default postMembersSyncService;

