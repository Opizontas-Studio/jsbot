import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';
import { BaseModel } from './BaseModel.js';

class ProcessModel extends BaseModel {
    static get tableName() {
        return 'processes';
    }

    static get jsonFields() {
        return ['details'];
    }

    static get arrayFields() {
        return ['supporters'];
    }

    /**
     * 获取流程记录
     * @param {number} id - 流程ID
     * @returns {Promise<Object>} 流程记录
     */
    static async getProcessById(id) {
        return this.findById(id);
    }

    /**
     * 更新流程状态
     * @param {number} id - 流程ID
     * @param {string} status - 新状态
     * @param {Object} [options] - 更新选项
     * @param {string} [options.result] - 流程结果
     * @param {string} [options.reason] - 状态更新原因
     * @param {string} [options.debateThreadId] - 辩诉帖ID
     * @param {string} [options.messageId] - 消息ID
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
                    messageId = CASE WHEN ? IS NOT NULL THEN ? ELSE messageId END,
                    details = CASE
                        WHEN ? IS NOT NULL THEN
                            json_set(
                                COALESCE(details, '{}'),
                                '$.debateThreadId',
                                ?
                            )
                        ELSE details
                    END,
                    updatedAt = ?
                WHERE id = ?`,
                [
                    status,
                    options.result,
                    options.result,
                    options.reason,
                    options.reason,
                    options.messageId,
                    options.messageId,
                    options.debateThreadId,
                    options.debateThreadId,
                    Date.now(),
                    id,
                ],
            );

            this._clearRelatedCache(process.targetId, process.executorId, id, options.messageId || process.messageId);
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
            this.clearCache(this.getCacheKey(`user_${targetId}_${includeCompleted}`));
            if (executorId !== targetId) {
                this.clearCache(this.getCacheKey(`user_${executorId}_${includeCompleted}`));
            }
        });

        // 如果提供了流程ID，清除特定流程的缓存
        if (processId) {
            this.clearCache(this.getCacheKey(processId));
        }

        // 如果提供了消息ID，清除消息相关的缓存
        if (messageId) {
            this.clearCache(this.getCacheKey(`msg_${messageId}`));
        }
    }

    /**
     * 检查并处理过期的流程
     * @returns {Promise<Array>} 已处理的过期流程列表
     */
    static async handleExpiredProcesses() {
        const now = Date.now();

        try {
            const expiredProcesses = await this.findAll(
                `status IN ('pending', 'in_progress') AND expireAt <= ?`,
                [now]
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
        const cacheKey = this.getCacheKey(`user_${userId}_${includeCompleted}`);
        const cached = this.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const now = Date.now();
            let where = '(targetId = ? OR executorId = ?)';
            const params = [userId, userId];

            if (!includeCompleted) {
                where += ` AND status IN ('pending', 'in_progress') AND expireAt > ?`;
                params.push(now);
            }

            const processes = await this.findAll(where, params, { cacheKey });
            return processes;
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
            const where = includeCompleted ? '' : `status IN ('pending', 'in_progress')`;
            return await this.findAll(where);
        } catch (error) {
            logTime(`获取全库流程记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 创建新的议事流程
     * @param {Object} data - 流程数据
     * @param {string} data.type - 流程类型 (court_mute/court_ban/debate)
     * @param {string} data.targetId - 目标用户ID
     * @param {string} data.executorId - 执行者ID
     * @param {string} [data.messageId] - 议事消息ID (可选，如果为空会使用临时占位符)
     * @param {number} data.expireAt - 流程到期时间戳
     * @param {Object} data.details - 处罚详情
     * @param {string} [data.statusMessageId] - 状态消息ID（仅debate类型使用）
     * @returns {Promise<Object>} 流程记录
     */
    static async createCourtProcess(data) {
        const { type, targetId, executorId, messageId, expireAt, details, statusMessageId = null } = data;

        try {
            const enrichedDetails = {
                ...details,
                executorId,
            };

            // 使用临时占位符代替null，确保满足NOT NULL约束
            const tempMessageId = messageId || `temp_${type}_${Date.now()}_${targetId.slice(-5)}`;

            const result = await dbManager.safeExecute(
                'run',
                `INSERT INTO processes (
                    type, targetId, executorId,
                    messageId, expireAt, status,
                    details, supporters, statusMessageId
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '[]', ?)`,
                [
                    type,
                    targetId,
                    executorId,
                    tempMessageId,
                    expireAt,
                    JSON.stringify(enrichedDetails),
                    statusMessageId,
                ],
            );

            // 清除相关缓存
            this._clearRelatedCache(targetId, executorId, result.lastID, tempMessageId);

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
        const cacheKey = this.getCacheKey(`msg_${messageId}`);
        return await this.findOne('messageId = ?', [messageId], cacheKey);
    }
}

export { ProcessModel };
