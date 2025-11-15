import { postMembersSyncService } from '../services/sync/postMembersSyncService.js';
import { userRolesSyncService } from '../services/sync/userRolesSyncService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * PostgreSQL同步调度器
 * 管理PostgreSQL数据同步任务的调度和执行
 */
export class PgSyncScheduler {
    constructor() {
        this.initialized = false;
    }

    /**
     * 初始化调度器
     */
    async initialize(client) {
        if (this.initialized) return;

        await ErrorHandler.handleService(
            async () => {
                // 初始化帖子列表（表结构已在 dbManager 中创建）
                await postMembersSyncService.initializeFromPostsMain();
                
                this.initialized = true;
                logTime('[PG同步调度] 调度器初始化完成');
            },
            'PG同步调度器初始化'
        );
    }

    /**
     * 执行帖子成员同步批次
     */
    async processPostMembersBatch(client) {
        return await postMembersSyncService.processBatch(client);
    }

    /**
     * 执行创作者身份组同步
     */
    async syncCreatorRoles(client) {
        return await userRolesSyncService.syncCreatorRoles(client);
    }

    /**
     * 接收来自 threadCleaner 的成员数据
     * @param {string} threadId - 帖子ID
     * @param {Collection} members - 成员集合
     * @param {Object} client - Discord客户端（可选）
     */
    async receiveMemberData(threadId, members, client = null) {
        await postMembersSyncService.receiveMemberData(threadId, members, client);
    }

    /**
     * 获取同步统计信息
     */
    async getStats() {
        return await postMembersSyncService.getStats();
    }

    /**
     * 检查是否已启用
     */
    isEnabled() {
        return this.initialized;
    }
}

export const pgSyncScheduler = new PgSyncScheduler();
export default pgSyncScheduler;

