import { dbManager } from '../manager.js';
import { logTime } from '../../utils/logger.js';

class ProcessModel {
    /**
     * 获取流程记录
     * @param {number} id - 流程ID
     * @returns {Promise<Object>} 流程记录
     */
    static async getProcessById(id) {
        const cacheKey = `process_${id}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const process = await dbManager.safeExecute(
            'get',
            'SELECT * FROM processes WHERE id = ?',
            [id]
        );

        if (process) {
            try {
                process.votes = JSON.parse(process.votes || '{}');
                process.messageIds = JSON.parse(process.messageIds || '[]');
                process.details = JSON.parse(process.details || '{}');
                process.supporters = JSON.parse(process.supporters || '[]');
                dbManager.setCache(cacheKey, process);
            } catch (error) {
                logTime(`JSON解析失败 [getProcessById]: ${error.message}`, true);
                process.votes = {};
                process.messageIds = [];
                process.details = {};
                process.supporters = [];
            }
        }

        return process;
    }

    /**
     * 更新流程状态
     * @param {number} id - 流程ID
     * @param {string} status - 新状态
     * @param {Object} [options] - 更新选项
     * @param {string} [options.result] - 流程结果
     * @param {string} [options.reason] - 状态更新原因
     * @returns {Promise<Object>} 更新后的流程记录
     */
    static async updateStatus(id, status, options = {}) {
        const process = await this.getProcessById(id);
        if (!process) throw new Error('流程记录不存在');

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET status = ?, 
                    result = CASE WHEN ? IS NOT NULL THEN ? ELSE result END,
                    reason = CASE WHEN ? IS NOT NULL THEN ? ELSE reason END,
                    updatedAt = ?
                WHERE id = ?`,
                [
                    status, 
                    options.result, options.result,
                    options.reason, options.reason,
                    Date.now(), 
                    id
                ]
            );

            // 清除相关缓存
            this._clearRelatedCache(process.punishmentId);

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新流程状态失败: ${error.message}`, true);
            throw error;
        }
    }
    /**
     * 更新诉求
     * @param {number} id - 流程ID
     * @param {string} side - 更新方 (red/blue)
     * @param {string} claim - 新诉求
     * @returns {Promise<Object>} 更新后的流程记录
     */
    static async updateClaim(id, side, claim) {
        const process = await this.getProcessById(id);
        if (!process) throw new Error('流程记录不存在');

        const field = side === 'red' ? 'redClaim' : 'blueClaim';

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET ${field} = ?, updatedAt = ?
                WHERE id = ?`,
                [claim, Date.now(), id]
            );

            // 清除相关缓存
            this._clearRelatedCache(process.punishmentId);

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新${side}方诉求失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清除相关缓存
     * @private
     * @param {number} punishmentId - 处罚ID
     */
    static _clearRelatedCache(punishmentId) {
        dbManager.clearCache(`active_process_${punishmentId}`);
        dbManager.clearCache(`process_${punishmentId}`);
    }

    /**
     * 检查并处理过期的流程
     * @returns {Promise<Array>} 已处理的过期流程列表
     */
    static async handleExpiredProcesses() {
        const now = Date.now();
        
        try {
            const expiredProcesses = await dbManager.safeExecute(
                'all',
                `SELECT * FROM processes 
                WHERE status IN ('pending', 'in_progress')
                AND expireAt <= ?`,
                [now]
            );

            for (const process of expiredProcesses) {
                await this.updateStatus(process.id, 'completed', {
                    result: 'cancelled',
                    reason: '流程已超时'
                });
            }

            return expiredProcesses;
        } catch (error) {
            logTime(`处理过期流程失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取用户相关的所有流程记录
     * @param {string} userId - 用户ID
     * @param {boolean} [includeCompleted=false] - 是否包含已完成记录
     * @returns {Promise<Array>} 流程记录列表
     */
    static async getUserProcesses(userId, includeCompleted = false) {
        try {
            const now = Date.now();
            const query = `
                SELECT p.* FROM processes p
                JOIN punishments pun ON p.punishmentId = pun.id
                WHERE pun.userId = ?
                ${!includeCompleted ? `
                    AND p.status IN ('pending', 'in_progress')
                    AND p.expireAt > ?
                ` : ''}
                ORDER BY p.createdAt DESC
            `;

            const processes = await dbManager.safeExecute(
                'all',
                query,
                !includeCompleted ? [userId, now] : [userId]
            );

            return processes.map(p => ({
                ...p,
                votes: JSON.parse(p.votes),
                messageIds: JSON.parse(p.messageIds)
            }));
        } catch (error) {
            logTime(`获取用户流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取所有流程记录
     * @param {boolean} [includeCompleted=false] - 是否包含已完成记录
     * @returns {Promise<Array>} 流程记录列表
     */
    static async getAllProcesses(includeCompleted = false) {
        try {
            const now = Date.now();
            const query = `
                SELECT * FROM processes 
                ${!includeCompleted ? `
                    WHERE status IN ('pending', 'in_progress')
                    AND expireAt > ?
                ` : ''}
                ORDER BY createdAt DESC
            `;

            const processes = await dbManager.safeExecute(
                'all',
                query,
                !includeCompleted ? [now] : []
            );

            return processes.map(p => ({
                ...p,
                votes: JSON.parse(p.votes || '{}'),
                messageIds: JSON.parse(p.messageIds || '[]'),
                details: JSON.parse(p.details || '{}'),
                supporters: JSON.parse(p.supporters || '[]')
            }));
        } catch (error) {
            logTime(`获取全库流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 创建新的议事流程
     * @param {Object} data - 流程数据
     * @param {string} data.type - 流程类型 (court_mute/court_ban)
     * @param {string} data.targetId - 目标用户ID
     * @param {string} data.executorId - 执行者ID
     * @param {string} data.messageId - 议事消息ID
     * @param {number} data.expireAt - 流程到期时间戳
     * @param {Object} data.details - 处罚详情
     * @returns {Promise<Object>} 流程记录
     */
    static async createCourtProcess(data) {
        const { 
            type, targetId, executorId,
            messageId, expireAt, details
        } = data;
        
        try {
            // 将申请人ID添加到details中
            const enrichedDetails = {
                ...details,
                executorId // 存储申请人ID
            };

            const result = await dbManager.safeExecute('run', `
                INSERT INTO processes (
                    type, targetId, executorId,
                    messageId, expireAt, status,
                    details, supporters
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '[]')
            `, [
                type, targetId, executorId,
                messageId, expireAt,
                JSON.stringify(enrichedDetails)
            ]);

            return this.getProcessById(result.lastID);
        } catch (error) {
            logTime(`创建议事流程失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取议事流程
     * @param {string} messageId - 议事消息ID
     * @returns {Promise<Object>} 流程记录
     */
    static async getProcessByMessageId(messageId) {
        const cacheKey = `process_msg_${messageId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const process = await dbManager.safeExecute(
            'get',
            'SELECT * FROM processes WHERE messageId = ?',
            [messageId]
        );

        if (process) {
            try {
                process.votes = JSON.parse(process.votes || '{}');
                process.messageIds = JSON.parse(process.messageIds || '[]');
                process.details = JSON.parse(process.details || '{}');
                process.supporters = JSON.parse(process.supporters || '[]');
                dbManager.setCache(cacheKey, process);
            } catch (error) {
                logTime(`JSON解析失败 [getProcessByMessageId]: ${error.message}`, true);
                process.votes = {};
                process.messageIds = [];
                process.details = {};
                process.supporters = [];
            }
        }

        return process;
    }

    /**
     * 获取用户是否已支持
     * @param {string} messageId - 议事消息ID
     * @param {string} userId - 用户ID
     * @returns {Promise<boolean>} 是否已支持
     */
    static async hasSupported(messageId, userId) {
        const process = await this.getProcessByMessageId(messageId);
        if (!process) return false;

        try {
            const supporters = Array.isArray(process.supporters) ? process.supporters : [];
            return supporters.includes(userId);
        } catch (error) {
            logTime(`检查支持状态失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 获取支持者数量
     * @param {string} messageId - 议事消息ID
     * @returns {Promise<number>} 支持者数量
     */
    static async getSupportCount(messageId) {
        const process = await this.getProcessByMessageId(messageId);
        if (!process) return 0;

        try {
            const supporters = Array.isArray(process.supporters) ? process.supporters : [];
            return supporters.length;
        } catch (error) {
            logTime(`获取支持数量失败: ${error.message}`, true);
            return 0;
        }
    }

    /**
     * 添加支持者并检查是否需要创建辩诉帖子
     * @param {string} messageId - 议事消息ID
     * @param {string} userId - 支持者ID
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} client - Discord客户端
     * @returns {Promise<{process: Object, debateThread: Object|null}>} 更新后的流程记录和可能创建的辩诉帖子
     */
    static async addSupporter(messageId, userId, guildConfig, client) {
        try {
            const process = await this.getProcessByMessageId(messageId);
            if (!process) throw new Error('议事流程不存在');

            let supporters = [];
            try {
                supporters = Array.isArray(process.supporters) ? process.supporters : [];
            } catch (error) {
                logTime(`解析支持者列表失败，使用空列表: ${error.message}`, true);
            }

            if (supporters.includes(userId)) {
                return { process, debateThread: null };
            }

            supporters.push(userId);
            let debateThread = null;

            // 检查是否达到所需支持数量
            if (supporters.length === guildConfig.courtSystem.requiredSupports && !process.debateThreadId) {
                // 创建辩诉帖子
                const debateForum = await client.channels.fetch(guildConfig.courtSystem.debateForumId);
                const details = process.details || {};
                
                debateThread = await debateForum.threads.create({
                    name: `${details.embed?.title?.replace('申请', '辩诉') || '辩诉帖'}`,
                    message: {
                        embeds: [{
                            ...(details.embed || {}),
                            title: details.embed?.title?.replace('申请', '辩诉') || '辩诉帖',
                            fields: [
                                ...(details.embed?.fields?.filter(f => f) || []),
                                {
                                    name: '支持人数',
                                    value: `${supporters.length || 0} 位议员`,
                                    inline: true
                                }
                            ]
                        }]
                    }
                });

                // 获取申请人和目标用户
                const [executor, target] = await Promise.all([
                    client.users.fetch(details.executorId).catch(() => null),
                    client.users.fetch(process.targetId).catch(() => null)
                ]);

                // 发送通知消息
                if (executor && target) {             
                    await debateThread.send({
                        content: [
                            `辩诉帖已创建，请双方当事人注意查看。`,
                            `- 申请人：<@${executor.id}>`,
                            `- 处罚对象：<@${target.id}>`
                        ].join('\n')
                    });
                }

                // 更新流程状态和辩诉帖子ID
                await dbManager.safeExecute(
                    'run',
                    `UPDATE processes 
                    SET status = 'in_progress', 
                        debateThreadId = ?,
                        supporters = ?,
                        updatedAt = ?
                    WHERE messageId = ?`,
                    [debateThread.id, JSON.stringify(supporters), Date.now(), messageId]
                );
            } else {
                // 仅更新支持者列表
                await dbManager.safeExecute(
                    'run',
                    `UPDATE processes 
                    SET supporters = ?, updatedAt = ?
                    WHERE messageId = ?`,
                    [JSON.stringify(supporters), Date.now(), messageId]
                );
            }

            // 清除缓存
            const process_id = process.id;
            dbManager.clearCache(`process_${process_id}`);
            dbManager.clearCache(`process_msg_${messageId}`);

            const updatedProcess = await this.getProcessByMessageId(messageId);
            return { process: updatedProcess, debateThread };
        } catch (error) {
            logTime(`添加支持者失败: ${error.message}`, true);
            throw error;
        }
    }
}

export { ProcessModel }; 