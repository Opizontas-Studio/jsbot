import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';

class ProcessModel {
    /**
     * 获取流程记录
     * @param {number} id - 流程ID
     * @returns {Promise<Object>} 流程记录
     */
    static async getProcessById(id) {
        const cacheKey = `process_${id}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const process = await dbManager.safeExecute('get', 'SELECT * FROM processes WHERE id = ?', [id]);

        if (process) {
            const parsedProcess = this._parseProcessJSON(process);
            dbManager.setCache(cacheKey, parsedProcess);
            return parsedProcess;
        }

        return null;
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
        if (!process) {
            throw new Error('流程记录不存在');
        }

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE processes 
	            SET status = ?, 
	                result = CASE WHEN ? IS NOT NULL THEN ? ELSE result END,
	                reason = CASE WHEN ? IS NOT NULL THEN ? ELSE reason END,
	                updatedAt = ?
	            WHERE id = ?`,
                [status, options.result, options.result, options.reason, options.reason, Date.now(), id],
            );

            // 使用修改后的清除缓存函数
            this._clearRelatedCache(process.targetId, process.executorId, id, process.messageId);

            return this.getProcessById(id);
        } catch (error) {
            logTime(`更新流程状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清除相关缓存
     * @private
     * @param {string} targetId - 目标用户ID
     * @param {string} executorId - 执行者ID
     * @param {number} [processId] - 流程ID（可选）
     * @param {string} [messageId] - 消息ID（可选）
     */
    static _clearRelatedCache(targetId, executorId, processId = null, messageId = null) {
        // 清除用户相关的所有缓存（目标用户和执行者）
        ['true', 'false'].forEach(includeCompleted => {
            dbManager.clearCache(`user_processes_${targetId}_${includeCompleted}`);
            if (executorId !== targetId) {
                dbManager.clearCache(`user_processes_${executorId}_${includeCompleted}`);
            }
        });

        // 如果提供了流程ID，清除特定流程的缓存
        if (processId) {
            dbManager.clearCache(`process_${processId}`);
        }

        // 如果提供了消息ID，清除消息相关的缓存
        if (messageId) {
            dbManager.clearCache(`process_msg_${messageId}`);
        }
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
                [now],
            );

            for (const process of expiredProcesses) {
                await this.updateStatus(process.id, 'completed', {
                    result: 'cancelled',
                    reason: '流程已超时',
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
	            ${
                    !includeCompleted
                        ? `
	                AND status IN ('pending', 'in_progress')
	                AND expireAt > ?
	            `
                        : ''
                }
	            ORDER BY createdAt DESC
	        `;

            const processes = await dbManager.safeExecute(
                'all',
                query,
                !includeCompleted ? [userId, userId, now] : [userId, userId],
            );

            return processes.map(p => this._parseProcessJSON(p));
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
            const query = `
	            SELECT * FROM processes 
	            ${
                    !includeCompleted
                        ? `
	                WHERE status IN ('pending', 'in_progress')
	            `
                        : ''
                }
	            ORDER BY createdAt DESC
	        `;

            const processes = await dbManager.safeExecute('all', query, !includeCompleted ? [] : []);

            return processes.map(p => this._parseProcessJSON(p));
        } catch (error) {
            logTime(`获取全库流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 创建新的议事流程
     * @param {Object} data - 流程数据
     * @param {string} data.type - 流程类型 (court_mute/court_ban/vote)
     * @param {string} data.targetId - 目标用户ID
     * @param {string} data.executorId - 执行者ID
     * @param {string} data.messageId - 议事消息ID
     * @param {number} data.expireAt - 流程到期时间戳
     * @param {Object} data.details - 处罚详情
     * @param {string} [data.statusMessageId] - 状态消息ID（仅vote类型使用）
     * @returns {Promise<Object>} 流程记录
     */
    static async createCourtProcess(data) {
        const { type, targetId, executorId, messageId, expireAt, details, statusMessageId = null } = data;

        try {
            const enrichedDetails = {
                ...details,
                executorId,
            };

            const result = await dbManager.safeExecute(
                'run',
                `
	            INSERT INTO processes (
	                type, targetId, executorId,
	                messageId, expireAt, status,
	                details, supporters, statusMessageId
	            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '[]', ?)
	        `,
                [type, targetId, executorId, messageId, expireAt, JSON.stringify(enrichedDetails), statusMessageId],
            );

            // 清除相关缓存
            this._clearRelatedCache(targetId, executorId, result.lastID, messageId);

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
        if (cached) {
            return cached;
        }

        const process = await dbManager.safeExecute('get', 'SELECT * FROM processes WHERE messageId = ?', [messageId]);

        if (process) {
            const parsedProcess = this._parseProcessJSON(process);
            dbManager.setCache(cacheKey, parsedProcess);
            return parsedProcess;
        }

        return null;
    }

    /**
     * 尝试解析JSON字符串，确保返回有效对象
     * @param {string|Object} data - 要解析的数据
     * @param {string} defaultValue - 解析失败时的默认值
     * @param {string} [context='unknown'] - 错误日志的上下文
     * @returns {Object} 解析后的对象
     */
    static tryParseJSON(data, defaultValue = '{}', context = 'unknown') {
        try {
            return typeof data === 'string' ? JSON.parse(data || defaultValue) : data || JSON.parse(defaultValue);
        } catch (error) {
            logTime(`JSON解析失败 [${context}]: ${error.message}`, true);
            return JSON.parse(defaultValue);
        }
    }

    /**
     * 解析流程记录的JSON字段
     * @private
     * @param {Object} process - 流程记录
     * @returns {Object} 处理后的流程记录
     */
    static _parseProcessJSON(process) {
        if (!process) {
            return null;
        }

        return {
            ...process,
            votes: this.tryParseJSON(process.votes, '{}', 'votes'),
            messageIds: this.tryParseJSON(process.messageIds, '[]', 'messageIds'),
            details: this.tryParseJSON(process.details, '{}', 'details'),
            supporters: this.tryParseJSON(process.supporters, '[]', 'supporters'),
            statusMessageId: process.statusMessageId || null,
        };
    }
}

export { ProcessModel };
