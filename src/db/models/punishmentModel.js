import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';

class PunishmentModel {
    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @param {string} data.userId - 被处罚用户ID
     * @param {string} data.type - 处罚类型 (ban/mute)
     * @param {string} data.reason - 处罚原因
     * @param {number} data.duration - 处罚时长(毫秒)，永封为-1
     * @param {string} data.executorId - 执行者ID
     * @param {boolean} [data.keepMessages=false] - 是否保留消息
     * @param {string} [data.channelId] - 处罚执行的频道ID
     * @param {number} [data.warningDuration=null] - 警告时长
     * @returns {Promise<Object>} 处罚记录
     */
    static async createPunishment(data) {
        const {
            userId,
            type,
            reason,
            duration,
            executorId,
            keepMessages = false,
            channelId,
            warningDuration = null,
        } = data;

        try {
            const result = await dbManager.safeExecute(
                'run',
                `
	            INSERT INTO punishments (
	                userId, type, reason, duration, warningDuration,
	                executorId, status, keepMessages, channelId
	            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
	        `,
                [userId, type, reason, duration, warningDuration, executorId, keepMessages ? 1 : 0, channelId],
            );

            return this.getPunishmentById(result.lastID);
        } catch (error) {
            logTime(`创建处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取处罚记录
     * @param {number} id - 处罚ID
     * @returns {Promise<Object>} 处罚记录
     */
    static async getPunishmentById(id) {
        const cacheKey = `punishment_${id}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const punishment = await dbManager.safeExecute('get', 'SELECT * FROM punishments WHERE id = ?', [id]);

        if (punishment) {
            punishment.keepMessages = Boolean(punishment.keepMessages);
            punishment.duration = Number(punishment.duration);
            punishment.warningDuration = punishment.warningDuration ? Number(punishment.warningDuration) : null;
            punishment.syncedServers = JSON.parse(punishment.syncedServers);

            dbManager.setCache(cacheKey, punishment);
        }

        return punishment;
    }

    /**
     * 获取用户的处罚历史
     * @param {string} userId - 用户ID
     * @param {boolean} [includeExpired=false] - 是否包含已过期记录
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getUserPunishments(userId, includeExpired = false) {
        const cacheKey = `user_punishments_${userId}_${includeExpired}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const now = Date.now();
        const query = `
	        SELECT * FROM punishments 
	        WHERE userId = ?
	        ${
                !includeExpired
                    ? `
	            AND (
	                (status = 'active' AND (duration = -1 OR createdAt + duration > ?))
	                OR status IN ('appealed', 'revoked')
	            )
	        `
                    : ''
            }
	        ORDER BY createdAt DESC
	    `;

        const params = [userId];
        if (!includeExpired) {
            params.push(now);
        }

        const punishments = await dbManager.safeExecute('all', query, params);

        const processedPunishments = punishments.map(p => ({
            ...p,
            syncedServers: JSON.parse(p.syncedServers),
            keepMessages: Boolean(p.keepMessages),
        }));

        dbManager.setCache(cacheKey, processedPunishments);
        return processedPunishments;
    }

    /**
     * 更新处罚状态
     * @param {number} id - 处罚ID
     * @param {string} status - 新状态
     * @param {string} [reason] - 状态更新原因
     * @returns {Promise<Object>} 更新后的处罚记录
     */
    static async updateStatus(id, status, reason = null) {
        const punishment = await this.getPunishmentById(id);
        if (!punishment) {
            throw new Error('处罚记录不存在');
        }

        try {
            logTime(`正在更新处罚状态: ID=${id}, 旧状态=${punishment.status}, 新状态=${status}`);

            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
	            SET status = ?, reason = CASE WHEN ? IS NOT NULL THEN ? ELSE reason END,
	            updatedAt = ?
	            WHERE id = ?`,
                [status, reason, reason, Date.now(), id],
            );

            // 使用修改后的清除缓存函数
            this._clearRelatedCache(punishment.userId, id);

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新处罚状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新处罚的同步状态
     * @param {number} id - 处罚ID
     * @param {string[]} syncedServers - 已同步的服务器ID列表
     * @returns {Promise<Object>} 更新后的处罚记录
     */
    static async updateSyncStatus(id, syncedServers) {
        const punishment = await this.getPunishmentById(id);
        if (!punishment) {
            throw new Error('处罚记录不存在');
        }

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
                SET syncedServers = ?, updatedAt = ?
                WHERE id = ?`,
                [JSON.stringify(syncedServers), Date.now(), id],
            );

            // 使用修改后的清除缓存函数
            this._clearRelatedCache(punishment.userId, id);

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新处罚 ${id} 的同步状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清除相关缓存
     * @private
     * @param {string} userId - 用户ID
     * @param {number} [punishmentId] - 处罚ID（可选）
     */
    static _clearRelatedCache(userId, punishmentId = null) {
        // 清除用户相关的所有缓存
        dbManager.clearCache(`active_punishment_${userId}`);
        dbManager.clearCache(`user_punishments_${userId}_true`);
        dbManager.clearCache(`user_punishments_${userId}_false`);

        // 如果提供了处罚ID，清除特定处罚的缓存
        if (punishmentId) {
            dbManager.clearCache(`punishment_${punishmentId}`);
        }
    }

    /**
     * 获取所有处罚记录
     * @param {boolean} [includeExpired=false] - 是否包含已过期记录
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getAllPunishments(includeExpired = false) {
        try {
            const now = Date.now();
            const query = `
	            SELECT * FROM punishments 
	            ${
                    !includeExpired
                        ? `
	                WHERE (
	                    (status = 'active' AND (duration = -1 OR createdAt + duration > ?))
	                    OR status IN ('appealed', 'revoked')
	                )
	            `
                        : ''
                }
	            ORDER BY createdAt DESC
	        `;

            const punishments = await dbManager.safeExecute('all', query, !includeExpired ? [now] : []);

            return punishments.map(p => ({
                ...p,
                syncedServers: JSON.parse(p.syncedServers),
                keepMessages: Boolean(p.keepMessages),
            }));
        } catch (error) {
            logTime(`获取全库处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 删除处罚记录
     * @param {number} id - 处罚ID
     * @returns {Promise<boolean>} 删除是否成功
     */
    static async deletePunishment(id) {
        try {
            const punishment = await this.getPunishmentById(id);
            if (!punishment) {
                throw new Error('处罚记录不存在');
            }

            await dbManager.safeExecute('run', 'DELETE FROM punishments WHERE id = ?', [id]);

            // 清除相关缓存
            this._clearRelatedCache(punishment.userId, id);

            return true;
        } catch (error) {
            logTime(`删除处罚记录失败: ${error.message}`, true);
            return false;
        }
    }
}

export { PunishmentModel };
