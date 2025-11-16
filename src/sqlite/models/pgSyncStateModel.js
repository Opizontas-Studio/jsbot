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
     * 失败时自动降低优先级
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
                    
                    // 失败时降低优先级：high -> medium -> low -> 暂停
                    updates.push(`priority = CASE priority
                        WHEN 'high' THEN 'medium'
                        WHEN 'medium' THEN 'low'
                        ELSE 'low'
                    END`);
                }

                updates.push(`last_sync_at = ${now}`);
                
                // 如果明确指定了优先级，则覆盖自动降级
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
     * 优先处理无错误的帖子，有错误的降级到低优先级等待
     */
    static async getThreadsToSync(limit = 45) {
        return await ErrorHandler.handleService(
            async () => {
                const now = Math.floor(Date.now() / 1000);
                const thirtyMinAgo = now - 1800; // 30分钟前

                // 按比例分配 limit: high(60%), medium(25%), low(15%)
                const queries = [
                    { priority: 'high', limit: Math.floor(limit * 0.6) },
                    { priority: 'medium', limit: Math.floor(limit * 0.25) },
                    { priority: 'low', limit: Math.floor(limit * 0.15) }
                ];

                const results = [];
                for (const query of queries) {
                    const rows = await dbManager.safeExecute('all', `
                        SELECT thread_id, last_sync_at, error_count
                        FROM pg_sync_state
                        WHERE priority = ?
                          AND (last_sync_at IS NULL OR last_sync_at < ?)
                          AND error_count < 3
                        ORDER BY 
                            error_count ASC,
                            last_sync_at ASC NULLS FIRST
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
                const twoHoursAgo = now - 7200;  // 2小时前（配合缓存有效期）

                const [total, byPriority, todaySynced, errors, pendingByPriority] = await Promise.all([
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state'),
                    dbManager.safeExecute('all', 'SELECT priority, COUNT(*) as count FROM pg_sync_state GROUP BY priority'),
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state WHERE last_sync_at >= ?', [todayStart]),
                    dbManager.safeExecute('get', 'SELECT COUNT(*) as count FROM pg_sync_state WHERE error_count > 0'),
                    // 获取当前轮待同步的数量（2小时内未同步且错误次数<3）
                    dbManager.safeExecute('all', `
                        SELECT priority, COUNT(*) as count 
                        FROM pg_sync_state 
                        WHERE (last_sync_at IS NULL OR last_sync_at < ?)
                          AND error_count < 3
                        GROUP BY priority
                    `, [twoHoursAgo])
                ]);

                const priorityCounts = {};
                byPriority.forEach(row => {
                    priorityCounts[row.priority] = row.count;
                });

                const pendingCounts = {};
                pendingByPriority.forEach(row => {
                    pendingCounts[row.priority] = row.count;
                });

                return {
                    totalThreads: total.count,
                    highPriority: priorityCounts.high || 0,
                    mediumPriority: priorityCounts.medium || 0,
                    lowPriority: priorityCounts.low || 0,
                    todaySynced: todaySynced.count,
                    errorCount: errors.count,
                    // 当前轮待同步数量
                    pendingHigh: pendingCounts.high || 0,
                    pendingMedium: pendingCounts.medium || 0,
                    pendingLow: pendingCounts.low || 0,
                    pendingTotal: (pendingCounts.high || 0) + (pendingCounts.medium || 0) + (pendingCounts.low || 0)
                };
            },
            '获取同步统计信息',
            { throwOnError: true }
        );
    }

    /**
     * 清理过期错误记录，并重置优先级
     * 当所有高优先级和中优先级帖子都处理完后，重置低优先级中的错误记录
     */
    static async cleanupErrors() {
        return await ErrorHandler.handleService(
            async () => {
                const now = Math.floor(Date.now() / 1000);
                const thirtyMinAgo = now - 1800;

                // 检查是否还有高/中优先级的待处理帖子
                const pending = await dbManager.safeExecute('get', `
                    SELECT COUNT(*) as count
                    FROM pg_sync_state
                    WHERE priority IN ('high', 'medium')
                      AND (last_sync_at IS NULL OR last_sync_at < ?)
                      AND error_count < 3
                `, [thirtyMinAgo]);

                // 如果还有高/中优先级的待处理帖子，不清理
                if (pending.count > 0) {
                    return;
                }

                // 重置低优先级中有错误的记录，恢复到medium优先级
                const result = await dbManager.safeExecute('run', `
                    UPDATE pg_sync_state 
                    SET error_count = 0, 
                        last_error = NULL,
                        priority = CASE
                            WHEN error_count >= 2 THEN 'medium'
                            ELSE priority
                        END
                    WHERE priority = 'low' AND error_count > 0
                `);

                if (result.changes > 0) {
                    logTime(`[PG同步] 完成一轮同步，重置 ${result.changes} 个错误记录`);
                }
            },
            '清理过期错误记录'
        );
    }
}

export { PgSyncStateModel };

