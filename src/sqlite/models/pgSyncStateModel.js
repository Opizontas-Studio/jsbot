import { dbManager } from '../dbManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { BaseModel } from './BaseModel.js';

/**
 * PostgreSQL同步状态模型
 * 管理帖子同步状态和优先级队列
 */
class PgSyncStateModel extends BaseModel {
    static get tableName() {
        return 'pg_sync_state';
    }

    /**
     * 更新帖子同步状态
     */
    static async updateThreadState(threadId, data) {
        return await ErrorHandler.handleService(
            async () => {
                const now = Math.floor(Date.now() / 1000);
                const {
                    memberCount,
                    success = true,
                    error = null,
                    priority = null,
                    isActive = null
                } = data;

                const updates = [`updated_at = ${now}`];
                const params = [];

                if (memberCount !== undefined) {
                    updates.push('member_count = ?');
                    params.push(memberCount);
                }

                if (success) {
                    updates.push(`last_success_at = ${now}`);
                    updates.push('sync_count = sync_count + 1');
                    updates.push('error_count = 0');
                    updates.push('last_error = NULL');
                } else if (error) {
                    updates.push('error_count = error_count + 1');
                    updates.push('last_error = ?');
                    params.push(error);
                }

                updates.push(`last_sync_at = ${now}`);
                
                if (priority) {
                    updates.push('priority = ?');
                    params.push(priority);
                }
                
                if (isActive !== null) {
                    updates.push('is_active = ?');
                    params.push(isActive ? 1 : 0);
                }

                await dbManager.safeExecute('run', `
                    INSERT INTO pg_sync_state (thread_id, last_sync_at, last_success_at, member_count, sync_count, priority)
                    VALUES (?, ${now}, ${now}, ?, 1, 'medium')
                    ON CONFLICT(thread_id) DO UPDATE SET ${updates.join(', ')}
                `, [threadId, memberCount || 0, ...params]);

                this.clearCache(this.getCacheKey(`thread_${threadId}`));
            },
            '更新帖子同步状态'
        );
    }

    /**
     * 获取需要同步的帖子列表
     */
    static async getThreadsToSync(limit = 45) {
        return await ErrorHandler.handleService(
            async () => {
                const now = Math.floor(Date.now() / 1000);
                const thirtyMinAgo = now - 1800; // 30分钟前

                const queries = [
                    { priority: 'high', limit: 30 },
                    { priority: 'medium', limit: 10 },
                    { priority: 'low', limit: 5 }
                ];

                const results = [];
                for (const query of queries) {
                    const rows = await dbManager.safeExecute('all', `
                        SELECT thread_id, last_sync_at, error_count
                        FROM pg_sync_state
                        WHERE priority = ?
                          AND (last_sync_at IS NULL OR last_sync_at < ?)
                          AND error_count < 3
                        ORDER BY last_sync_at ASC NULLS FIRST
                        LIMIT ?
                    `, [query.priority, thirtyMinAgo, query.limit]);
                    
                    results.push(...rows.map(r => r.thread_id));
                }

                return results;
            },
            '获取待同步帖子列表',
            { throwOnError: true }
        );
    }

    /**
     * 批量初始化帖子状态
     */
    static async initializeThreads(threadIds, priority = 'medium') {
        return await ErrorHandler.handleService(
            async () => {
                const stmt = await dbManager.getDb().prepare(`
                    INSERT OR IGNORE INTO pg_sync_state (thread_id, priority)
                    VALUES (?, ?)
                `);

                for (const threadId of threadIds) {
                    await stmt.run(threadId, priority);
                }
                await stmt.finalize();

                // logTime(`[PG同步] 初始化 ${threadIds.length} 个帖子状态`);
            },
            '批量初始化帖子状态'
        );
    }

    /**
     * 更新帖子优先级
     */
    static async updatePriority(threadId, priority) {
        return await ErrorHandler.handleService(
            async () => {
                await dbManager.safeExecute('run', `
                    UPDATE pg_sync_state 
                    SET priority = ?, updated_at = strftime('%s', 'now')
                    WHERE thread_id = ?
                `, [priority, threadId]);

                this.clearCache(this.getCacheKey(`thread_${threadId}`));
            },
            '更新帖子优先级'
        );
    }

    /**
     * 获取同步统计信息
     */
    static async getStats() {
        return await ErrorHandler.handleService(
            async () => {
                const now = Math.floor(Date.now() / 1000);
                const todayStart = now - (now % 86400);

                const [total, byPriority, todaySynced, errors] = await Promise.all([
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state'),
                    dbManager.safeExecute('all', 'SELECT priority, COUNT(*) as count FROM pg_sync_state GROUP BY priority'),
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state WHERE last_sync_at >= ?', [todayStart]),
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state WHERE error_count > 0')
                ]);

                const priorityCounts = {};
                byPriority.forEach(row => {
                    priorityCounts[row.priority] = row.count;
                });

                return {
                    totalThreads: total.count,
                    highPriority: priorityCounts.high || 0,
                    mediumPriority: priorityCounts.medium || 0,
                    lowPriority: priorityCounts.low || 0,
                    todaySynced: todaySynced.count,
                    errorCount: errors.count
                };
            },
            '获取同步统计信息',
            { throwOnError: true }
        );
    }

    /**
     * 清理过期错误记录
     */
    static async cleanupErrors() {
        return await ErrorHandler.handleService(
            async () => {
                const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 86400);

                const result = await dbManager.safeExecute('run', `
                    UPDATE pg_sync_state 
                    SET error_count = 0, last_error = NULL
                    WHERE error_count >= 3 AND last_sync_at < ?
                `, [sevenDaysAgo]);

                if (result.changes > 0) {
                    logTime(`[PG同步] 清理 ${result.changes} 个过期错误记录`);
                }
            },
            '清理过期错误记录'
        );
    }
}

export { PgSyncStateModel };

