import { dbManager } from '../manager.js';
import { logTime } from '../../utils/logger.js';
import { ProcessModel } from './process.js';

class PunishmentModel {
    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @param {string} data.userId - 被处罚用户ID
     * @param {string} data.guildId - 服务器ID
     * @param {string} data.type - 处罚类型 (ban/mute/warn)
     * @param {string} data.reason - 处罚原因
     * @param {number} data.duration - 处罚时长(毫秒)，永封为-1
     * @param {string} data.executorId - 执行者ID
     * @param {boolean} [data.keepMessages=false] - 是否保留消息
     * @returns {Promise<Object>} 处罚记录
     */
    static async createPunishment(data) {
        const { 
            userId, guildId, type, reason, duration, executorId, 
            keepMessages = false 
        } = data;

        const expireAt = duration === -1 ? -1 : Date.now() + duration;
        
        try {
            const result = await dbManager.safeExecute('run', `
                INSERT INTO punishments (
                    userId, guildId, type, reason, duration, expireAt, 
                    executorId, status, keepMessages
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
            `, [userId, guildId, type, reason, duration, expireAt, executorId, keepMessages ? 1 : 0]);

            // 清除相关缓存
            this._clearRelatedCache(guildId, userId);

            return this.getPunishmentById(result.lastID);
        } catch (error) {
            logTime(`创建处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 创建处罚记录和关联流程
     * @param {Object} punishmentData - 处罚数据
     * @param {Object} processData - 流程数据
     * @returns {Promise<Object>}
     */
    static async createPunishmentWithProcess(punishmentData, processData) {
        return await dbManager.transaction(async (db) => {
            const punishment = await this.createPunishment(punishmentData);
            processData.punishmentId = punishment.id;
            const process = await ProcessModel.createProcess(processData);
            return { punishment, process };
        });
    }

    /**
     * 获取处罚记录
     * @param {number} id - 处罚ID
     * @returns {Promise<Object>} 处罚记录
     */
    static async getPunishmentById(id) {
        const cacheKey = `punishment_${id}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const punishment = await dbManager.safeExecute(
            'get',
            'SELECT * FROM punishments WHERE id = ?',
            [id]
        );

        if (punishment) {
            punishment.syncedServers = JSON.parse(punishment.syncedServers);
            punishment.keepMessages = Boolean(punishment.keepMessages);
            dbManager.setCache(cacheKey, punishment);
        }

        return punishment;
    }

    /**
     * 获取用户在指定服务器的活跃处罚
     * @param {string} userId - 用户ID
     * @param {string} guildId - 服务器ID
     * @returns {Promise<Object>} 活跃处罚记录
     */
    static async getActivePunishment(userId, guildId) {
        const cacheKey = `active_punishment_${userId}_${guildId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const punishment = await dbManager.safeExecute(
            'get',
            `SELECT * FROM punishments 
            WHERE userId = ? AND guildId = ? 
            AND status = 'active' 
            AND (expireAt = -1 OR expireAt > ?)
            ORDER BY createdAt DESC LIMIT 1`,
            [userId, guildId, Date.now()]
        );

        if (punishment) {
            punishment.syncedServers = JSON.parse(punishment.syncedServers);
            punishment.keepMessages = Boolean(punishment.keepMessages);
            dbManager.setCache(cacheKey, punishment);
        }

        return punishment;
    }

    /**
     * 获取用户在指定服务器的处罚历史
     * @param {string} userId - 用户ID
     * @param {string} guildId - 服务器ID
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getUserPunishments(userId, guildId) {
        const cacheKey = `user_punishments_${userId}_${guildId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const punishments = await dbManager.safeExecute(
            'all',
            `SELECT * FROM punishments 
            WHERE userId = ? AND guildId = ?
            ORDER BY createdAt DESC`,
            [userId, guildId]
        );

        const processedPunishments = punishments.map(p => ({
            ...p,
            syncedServers: JSON.parse(p.syncedServers),
            keepMessages: Boolean(p.keepMessages)
        }));

        dbManager.setCache(cacheKey, processedPunishments);
        return processedPunishments;
    }

    /**
     * 获取需要同步的处罚记录
     * @param {string} guildId - 服务器ID
     * @returns {Promise<Array>} 待同步的处罚记录列表
     */
    static async getPendingSyncs(guildId) {
        return await dbManager.safeExecute(
            'all',
            `SELECT * FROM punishments 
            WHERE guildId = ? AND synced = 0 
            AND status = 'active'
            AND (expireAt = -1 OR expireAt > ?)`,
            [guildId, Date.now()]
        );
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
        if (!punishment) throw new Error('处罚记录不存在');

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
                SET status = ?, reason = CASE WHEN ? IS NOT NULL THEN ? ELSE reason END,
                updatedAt = ?
                WHERE id = ?`,
                [status, reason, reason, Date.now(), id]
            );

            // 清除相关缓存
            this._clearRelatedCache(punishment.guildId, punishment.userId);

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新处罚状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新同步状态
     * @param {number} id - 处罚ID
     * @param {string[]} syncedServers - 已同步的服务器ID列表
     * @returns {Promise<Object>} 更新后的处罚记录
     */
    static async updateSyncStatus(id, syncedServers) {
        const punishment = await this.getPunishmentById(id);
        if (!punishment) throw new Error('处罚记录不存在');

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
                SET synced = ?, syncedServers = ?, updatedAt = ?
                WHERE id = ?`,
                [1, JSON.stringify(syncedServers), Date.now(), id]
            );

            // 清除相关缓存
            this._clearRelatedCache(punishment.guildId, punishment.userId);

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新同步状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清除相关缓存
     * @private
     * @param {string} guildId - 服务器ID
     * @param {string} userId - 用户ID
     */
    static _clearRelatedCache(guildId, userId) {
        dbManager.clearCache(`active_punishment_${userId}_${guildId}`);
        dbManager.clearCache(`user_punishments_${userId}_${guildId}`);
        // 其他相关缓存...
    }

    /**
     * 检查并处理过期的处罚
     * @returns {Promise<Array>} 已处理的过期处罚列表
     */
    static async handleExpiredPunishments() {
        const now = Date.now();
        
        try {
            const expiredPunishments = await dbManager.safeExecute(
                'all',
                `SELECT * FROM punishments 
                WHERE status = 'active' 
                AND expireAt > 0 
                AND expireAt <= ?`,
                [now]
            );

            for (const punishment of expiredPunishments) {
                await this.updateStatus(punishment.id, 'expired', '处罚已到期');
            }

            return expiredPunishments;
        } catch (error) {
            logTime(`处理过期处罚失败: ${error.message}`, true);
            throw error;
        }
    }
    
    /**
     * 获取所有处罚记录
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getAllPunishments() {
        try {
            const punishments = await dbManager.safeExecute(
                'all',
                `SELECT * FROM punishments 
                ORDER BY createdAt DESC`
            );

            return punishments.map(p => ({
                ...p,
                syncedServers: JSON.parse(p.syncedServers),
                keepMessages: Boolean(p.keepMessages)
            }));
        } catch (error) {
            logTime(`获取全库处罚记录失败: ${error.message}`, true);
            throw error;
        }
    } 
}

export { PunishmentModel }; 