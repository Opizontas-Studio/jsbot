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
        this.isThreadCleanupRunning = false; // 标记是否有清理任务正在运行
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
        // 如果有清理任务正在运行，跳过本次同步以避免API冲突
        if (this.isThreadCleanupRunning) {
            logTime('[帖子成员同步] 检测到清理任务正在运行，跳过本次同步批次');
            return { processed: 0, cached: 0, skipped: true };
        }
        
        return await postMembersSyncService.processBatch(client);
    }

    /**
     * 执行所有用户身份组同步
     */
    async syncAllUserRoles(client) {
        return await userRolesSyncService.syncAllUserRoles(client);
    }

    /**
     * 接收来自 threadCleaner 的成员数据（仅缓存）
     * @param {string} threadId - 帖子ID
     * @param {Collection} members - 成员集合
     * @param {Object} client - Discord客户端（可选）
     */
    async receiveMemberData(threadId, members, client = null) {
        await postMembersSyncService.receiveMemberData(threadId, members, client);
    }

    /**
     * 批量同步所有缓存的成员数据
     */
    async flushCachedData() {
        return await postMembersSyncService.flushCachedData();
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

    /**
     * 设置清理任务运行状态
     * @param {boolean} isRunning - 是否正在运行
     */
    setThreadCleanupRunning(isRunning) {
        this.isThreadCleanupRunning = isRunning;
        if (isRunning) {
            logTime('[任务协调] 标记清理任务开始，帖子成员同步将暂停');
        } else {
            logTime('[任务协调] 清理任务完成，帖子成员同步已恢复');
        }
    }

    /**
     * 检查清理任务是否正在运行
     * @returns {boolean}
     */
    isCleanupRunning() {
        return this.isThreadCleanupRunning;
    }
}

export const pgSyncScheduler = new PgSyncScheduler();
export default pgSyncScheduler;

