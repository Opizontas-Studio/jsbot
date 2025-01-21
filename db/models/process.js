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
                SELECT * FROM processes 
                WHERE (targetId = ? OR executorId = ?)
                ${!includeCompleted ? `
                    AND status IN ('pending', 'in_progress')
                    AND expireAt > ?
                ` : ''}
                ORDER BY createdAt DESC
            `;

            const processes = await dbManager.safeExecute(
                'all',
                query,
                !includeCompleted ? [userId, userId, now] : [userId, userId]
            );

            return processes.map(p => ({
                ...p,
                votes: JSON.parse(p.votes || '{}'),
                messageIds: JSON.parse(p.messageIds || '[]'),
                details: JSON.parse(p.details || '{}'),
                supporters: JSON.parse(p.supporters || '[]')
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
}

export { ProcessModel }; 