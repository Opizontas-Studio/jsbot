import { dbManager } from '../manager.js';
import { logTime } from '../../utils/logger.js';
import { PunishmentModel } from './punishment.js';

class ProcessModel {
    /**
     * 创建新的流程记录
     * @param {Object} data - 流程数据
     * @param {number} data.punishmentId - 关联的处罚ID
     * @param {string} data.type - 流程类型 (appeal/vote/debate)
     * @param {number} data.expireAt - 流程到期时间戳
     * @param {string} [data.redClaim] - 红方诉求
     * @param {string} [data.blueClaim] - 蓝方诉求
     * @returns {Promise<Object>} 流程记录
     */
    static async createProcess(data) {
        const { 
            punishmentId, type, expireAt,
            redClaim = null, blueClaim = null 
        } = data;
        
        try {
            const result = await dbManager.safeExecute('run', `
                INSERT INTO processes (
                    punishmentId, type, expireAt, status,
                    redClaim, blueClaim
                ) VALUES (?, ?, ?, 'pending', ?, ?)
            `, [punishmentId, type, expireAt, redClaim, blueClaim]);

            // 清除相关缓存
            this._clearRelatedCache(punishmentId);

            return this.getProcessById(result.lastID);
        } catch (error) {
            logTime(`创建流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

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
            process.votes = JSON.parse(process.votes);
            process.messageIds = JSON.parse(process.messageIds);
            dbManager.setCache(cacheKey, process);
        }

        return process;
    }

    /**
     * 获取处罚相关的活跃流程
     * @param {number} punishmentId - 处罚ID
     * @returns {Promise<Object>} 活跃流程记录
     */
    static async getActiveProcess(punishmentId) {
        const cacheKey = `active_process_${punishmentId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const process = await dbManager.safeExecute(
            'get',
            `SELECT * FROM processes 
            WHERE punishmentId = ? 
            AND status IN ('pending', 'in_progress')
            AND expireAt > ?
            ORDER BY createdAt DESC LIMIT 1`,
            [punishmentId, Date.now()]
        );

        if (process) {
            process.votes = JSON.parse(process.votes);
            process.messageIds = JSON.parse(process.messageIds);
            dbManager.setCache(cacheKey, process);
        }

        return process;
    }

    /**
     * 获取所有活跃流程
     * @returns {Promise<Array>} 活跃流程列表
     */
    static async getAllActiveProcesses() {
        const now = Date.now();
        const processes = await dbManager.safeExecute(
            'all',
            `SELECT * FROM processes 
            WHERE status IN ('pending', 'in_progress')
            AND expireAt > ?
            ORDER BY createdAt DESC`,
            [now]
        );

        return processes.map(process => ({
            ...process,
            votes: JSON.parse(process.votes),
            messageIds: JSON.parse(process.messageIds)
        }));
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
     * 更新投票记录
     * @param {number} id - 流程ID
     * @param {string} userId - 投票用户ID
     * @param {string} vote - 投票值 (approve/reject)
     * @returns {Promise<Object>} 更新后的流程记录
     */
    static async updateVote(id, userId, vote) {
        const process = await this.getProcessById(id);
        if (!process) throw new Error('流程记录不存在');

        const votes = process.votes;
        votes[userId] = vote;

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET votes = ?, updatedAt = ?
                WHERE id = ?`,
                [JSON.stringify(votes), Date.now(), id]
            );

            // 清除相关缓存
            this._clearRelatedCache(process.punishmentId);

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新投票记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新消息ID列表
     * @param {number} id - 流程ID
     * @param {string[]} messageIds - 消息ID列表
     * @returns {Promise<Object>} 更新后的流程记录
     */
    static async updateMessageIds(id, messageIds) {
        const process = await this.getProcessById(id);
        if (!process) throw new Error('流程记录不存在');

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET messageIds = ?, updatedAt = ?
                WHERE id = ?`,
                [JSON.stringify(messageIds), Date.now(), id]
            );

            // 清除相关缓存
            this._clearRelatedCache(process.punishmentId);

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新消息ID列表失败: ${error.message}`, true);
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
                votes: JSON.parse(p.votes),
                messageIds: JSON.parse(p.messageIds)
            }));
        } catch (error) {
            logTime(`获取全库流程记录失败: ${error.message}`, true);
            throw error;
        }
    }
}

export { ProcessModel }; 