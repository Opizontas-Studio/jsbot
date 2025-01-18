import { dbManager } from '../utils/db.js';

class PunishmentModel {
    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @returns {Promise<Object>}
     */
    static async createPunishment(data) {
        const db = dbManager.getDb();
        const { userId, guildId, type, reason, duration, expireAt, executorId } = data;
        
        const result = await db.run(`
            INSERT INTO punishments (
                userId, guildId, type, reason, duration, expireAt, executorId
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [userId, guildId, type, reason, duration, expireAt, executorId]);

        return this.getPunishmentById(result.lastID);
    }

    /**
     * 获取处罚记录
     * @param {number} id - 处罚ID
     * @returns {Promise<Object>}
     */
    static async getPunishmentById(id) {
        const db = dbManager.getDb();
        return await db.get('SELECT * FROM punishments WHERE id = ?', [id]);
    }

    /**
     * 获取用户在指定服务器的处罚历史
     * @param {String} userId - 用户ID
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    static async getUserPunishments(userId, guildId) {
        const db = dbManager.getDb();
        return await db.all(`
            SELECT * FROM punishments 
            WHERE userId = ? AND guildId = ?
            ORDER BY createdAt DESC
        `, [userId, guildId]);
    }

    /**
     * 获取服务器的活跃处罚
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    static async getActivePunishments(guildId) {
        const db = dbManager.getDb();
        const now = Date.now();
        return await db.all(`
            SELECT * FROM punishments 
            WHERE guildId = ? 
            AND status = 'active' 
            AND expireAt > ?
        `, [guildId, now]);
    }

    /**
     * 更新处罚状态
     * @param {number} id - 处罚ID
     * @param {String} status - 新状态
     * @returns {Promise<Object>}
     */
    static async updatePunishmentStatus(id, status) {
        const db = dbManager.getDb();
        await db.run(`
            UPDATE punishments 
            SET status = ?, updatedAt = ?
            WHERE id = ?
        `, [status, Date.now(), id]);

        return this.getPunishmentById(id);
    }

    /**
     * 更新同步状态
     * @param {number} id - 处罚ID
     * @param {boolean} synced - 同步状态
     * @param {Array<string>} syncedServers - 已同步的服务器列表
     * @returns {Promise<Object>}
     */
    static async updateSyncStatus(id, synced, syncedServers = []) {
        const db = dbManager.getDb();
        await db.run(`
            UPDATE punishments 
            SET synced = ?, syncedServers = ?, updatedAt = ?
            WHERE id = ?
        `, [synced ? 1 : 0, JSON.stringify(syncedServers), Date.now(), id]);

        return this.getPunishmentById(id);
    }
}

export default PunishmentModel; 