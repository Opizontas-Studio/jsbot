import { dbManager } from './db.js';
import { logTime } from '../utils/logger.js';

class PunishmentModel {
    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @returns {Promise<Object>}
     */
    static async createPunishment(data) {
        const db = dbManager.getDb();
        const { userId, guildId, type, reason, duration, expireAt, executorId } = data;
        
        try {
            const result = await dbManager.safeExecute('run', `
                INSERT INTO punishments (
                    userId, guildId, type, reason, duration, expireAt, executorId
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [userId, guildId, type, reason, duration, expireAt, executorId]);

            // 清除相关缓存
            dbManager.clearCache(`active_${guildId}`);
            dbManager.clearCache(`user_${userId}_${guildId}`);

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
     * @returns {Promise<Object>}
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
            dbManager.setCache(cacheKey, punishment);
        }

        return punishment;
    }

    /**
     * 获取用户在指定服务器的处罚历史
     * @param {String} userId - 用户ID
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    static async getUserPunishments(userId, guildId) {
        const cacheKey = `user_${userId}_${guildId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const punishments = await dbManager.safeExecute(
            'all',
            `SELECT * FROM punishments 
            WHERE userId = ? AND guildId = ?
            ORDER BY createdAt DESC`,
            [userId, guildId]
        );

        punishments.forEach(p => {
            p.syncedServers = JSON.parse(p.syncedServers);
        });

        dbManager.setCache(cacheKey, punishments);
        return punishments;
    }

    /**
     * 获取服务器的活跃处罚
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    static async getActivePunishments(guildId) {
        const cacheKey = `active_${guildId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) return cached;

        const now = Date.now();
        const punishments = await dbManager.safeExecute(
            'all',
            `SELECT * FROM punishments 
            WHERE guildId = ? 
            AND status = 'active' 
            AND expireAt > ?`,
            [guildId, now]
        );

        punishments.forEach(p => {
            p.syncedServers = JSON.parse(p.syncedServers);
        });

        dbManager.setCache(cacheKey, punishments);
        return punishments;
    }

    /**
     * 更新处罚状态
     * @param {number} id - 处罚ID
     * @param {String} status - 新状态
     * @returns {Promise<Object>}
     */
    static async updatePunishmentStatus(id, status) {
        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
                SET status = ?, updatedAt = ?
                WHERE id = ?`,
                [status, Date.now(), id]
            );

            // 清除所有相关缓存
            const punishment = await this.getPunishmentById(id);
            if (punishment) {
                dbManager.clearCache(`active_${punishment.guildId}`);
                dbManager.clearCache(`user_${punishment.userId}_${punishment.guildId}`);
                dbManager.clearCache(`punishment_${id}`);
            }

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新处罚状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新同步状态
     * @param {number} id - 处罚ID
     * @param {boolean} synced - 同步状态
     * @param {Array<string>} syncedServers - 已同步的服务器列表
     * @returns {Promise<Object>}
     */
    static async updateSyncStatus(id, synced, syncedServers = []) {
        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
                SET synced = ?, syncedServers = ?, updatedAt = ?
                WHERE id = ?`,
                [synced ? 1 : 0, JSON.stringify(syncedServers), Date.now(), id]
            );

            // 清除缓存
            dbManager.clearCache(`punishment_${id}`);
            const punishment = await this.getPunishmentById(id);
            if (punishment) {
                dbManager.clearCache(`active_${punishment.guildId}`);
                dbManager.clearCache(`user_${punishment.userId}_${punishment.guildId}`);
            }

            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`更新同步状态失败: ${error.message}`, true);
            throw error;
        }
    }
}

export default PunishmentModel; 