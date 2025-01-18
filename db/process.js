import { dbManager } from './db.js';
import { logTime } from '../utils/logger.js';

class ProcessModel {
    /**
     * 创建新的流程记录
     * @param {Object} data - 流程数据
     * @returns {Promise<Object>}
     */
    static async createProcess(data) {
        try {
            const { punishmentId, type, expireAt } = data;
            
            const result = await dbManager.safeExecute('run', `
                INSERT INTO processes (
                    punishmentId, type, expireAt
                ) VALUES (?, ?, ?)
            `, [punishmentId, type, expireAt]);

            // 清除相关缓存
            dbManager.clearCache(`process_${result.lastID}`);
            dbManager.clearCache(`punishment_processes_${punishmentId}`);
            dbManager.clearCache('active_processes');

            return this.getProcessById(result.lastID);
        } catch (error) {
            logTime(`创建流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取流程记录
     * @param {number} id - 流程ID
     * @returns {Promise<Object>}
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
     * 获取处罚相关的所有流程
     * @param {number} punishmentId - 处罚ID
     * @returns {Promise<Array>}
     */
    static async getPunishmentProcesses(punishmentId) {
        const cacheKey = `punishment_processes_${punishmentId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const processes = await dbManager.safeExecute(
            'all',
            `SELECT * FROM processes 
            WHERE punishmentId = ?
            ORDER BY createdAt DESC`,
            [punishmentId]
        );

        const processesWithParsedData = processes.map(process => ({
            ...process,
            votes: JSON.parse(process.votes),
            messageIds: JSON.parse(process.messageIds)
        }));

        dbManager.setCache(cacheKey, processesWithParsedData);
        return processesWithParsedData;
    }

    /**
     * 获取活跃的流程
     * @returns {Promise<Array>}
     */
    static async getActiveProcesses() {
        const cacheKey = 'active_processes';
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const now = Date.now();
        const processes = await dbManager.safeExecute(
            'all',
            `SELECT * FROM processes 
            WHERE status IN ('pending', 'in_progress')
            AND expireAt > ?`,
            [now]
        );

        const processesWithParsedData = processes.map(process => ({
            ...process,
            votes: JSON.parse(process.votes),
            messageIds: JSON.parse(process.messageIds)
        }));

        dbManager.setCache(cacheKey, processesWithParsedData);
        return processesWithParsedData;
    }

    /**
     * 更新流程状态
     * @param {number} id - 流程ID
     * @param {String} status - 新状态
     * @param {String} result - 结果
     * @param {String} reason - 原因
     * @returns {Promise<Object>}
     */
    static async updateProcessStatus(id, status, result = null, reason = '') {
        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET status = ?, result = ?, reason = ?, updatedAt = ?
                WHERE id = ?`,
                [status, result, reason, Date.now(), id]
            );

            // 清除相关缓存
            const process = await this.getProcessById(id);
            if (process) {
                dbManager.clearCache(`process_${id}`);
                dbManager.clearCache(`punishment_processes_${process.punishmentId}`);
                dbManager.clearCache('active_processes');
            }

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新流程状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 添加投票
     * @param {number} id - 流程ID
     * @param {String} userId - 用户ID
     * @param {String} vote - 投票（approve/reject）
     * @returns {Promise<Object>}
     */
    static async addVote(id, userId, vote) {
        return await dbManager.transaction(async (db) => {
            try {
                const process = await this.getProcessById(id);
                if (!process) return null;

                const votes = process.votes;
                votes[userId] = vote;

                await dbManager.safeExecute(
                    'run',
                    `UPDATE processes 
                    SET votes = ?, updatedAt = ?
                    WHERE id = ?`,
                    [JSON.stringify(votes), Date.now(), id]
                );

                // 清除相关缓存
                dbManager.clearCache(`process_${id}`);
                dbManager.clearCache(`punishment_processes_${process.punishmentId}`);
                dbManager.clearCache('active_processes');

                return this.getProcessById(id);
            } catch (error) {
                logTime(`添加投票失败: ${error.message}`, true);
                throw error;
            }
        });
    }

    /**
     * 更新消息ID列表
     * @param {number} id - 流程ID
     * @param {Array<string>} messageIds - 消息ID列表
     * @returns {Promise<Object>}
     */
    static async updateMessageIds(id, messageIds) {
        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
                SET messageIds = ?, updatedAt = ?
                WHERE id = ?`,
                [JSON.stringify(messageIds), Date.now(), id]
            );

            // 清除相关缓存
            const process = await this.getProcessById(id);
            if (process) {
                dbManager.clearCache(`process_${id}`);
                dbManager.clearCache(`punishment_processes_${process.punishmentId}`);
            }

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新消息ID列表失败: ${error.message}`, true);
            throw error;
        }
    }
}

export default ProcessModel; 