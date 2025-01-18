import { dbManager } from '../utils/db.js';

class ProcessModel {
    /**
     * 创建新的流程记录
     * @param {Object} data - 流程数据
     * @returns {Promise<Object>}
     */
    static async createProcess(data) {
        const db = dbManager.getDb();
        const { punishmentId, type, expireAt } = data;
        
        const result = await db.run(`
            INSERT INTO processes (
                punishmentId, type, expireAt
            ) VALUES (?, ?, ?)
        `, [punishmentId, type, expireAt]);

        return this.getProcessById(result.lastID);
    }

    /**
     * 获取流程记录
     * @param {number} id - 流程ID
     * @returns {Promise<Object>}
     */
    static async getProcessById(id) {
        const db = dbManager.getDb();
        const process = await db.get('SELECT * FROM processes WHERE id = ?', [id]);
        if (process) {
            process.votes = JSON.parse(process.votes);
            process.messageIds = JSON.parse(process.messageIds);
        }
        return process;
    }

    /**
     * 获取处罚相关的所有流程
     * @param {number} punishmentId - 处罚ID
     * @returns {Promise<Array>}
     */
    static async getPunishmentProcesses(punishmentId) {
        const db = dbManager.getDb();
        const processes = await db.all(`
            SELECT * FROM processes 
            WHERE punishmentId = ?
            ORDER BY createdAt DESC
        `, [punishmentId]);

        return processes.map(process => ({
            ...process,
            votes: JSON.parse(process.votes),
            messageIds: JSON.parse(process.messageIds)
        }));
    }

    /**
     * 获取活跃的流程
     * @returns {Promise<Array>}
     */
    static async getActiveProcesses() {
        const db = dbManager.getDb();
        const now = Date.now();
        const processes = await db.all(`
            SELECT * FROM processes 
            WHERE status IN ('pending', 'in_progress')
            AND expireAt > ?
        `, [now]);

        return processes.map(process => ({
            ...process,
            votes: JSON.parse(process.votes),
            messageIds: JSON.parse(process.messageIds)
        }));
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
        const db = dbManager.getDb();
        await db.run(`
            UPDATE processes 
            SET status = ?, result = ?, reason = ?, updatedAt = ?
            WHERE id = ?
        `, [status, result, reason, Date.now(), id]);

        return this.getProcessById(id);
    }

    /**
     * 添加投票
     * @param {number} id - 流程ID
     * @param {String} userId - 用户ID
     * @param {String} vote - 投票（approve/reject）
     * @returns {Promise<Object>}
     */
    static async addVote(id, userId, vote) {
        const db = dbManager.getDb();
        const process = await this.getProcessById(id);
        if (!process) return null;

        const votes = process.votes;
        votes[userId] = vote;

        await db.run(`
            UPDATE processes 
            SET votes = ?, updatedAt = ?
            WHERE id = ?
        `, [JSON.stringify(votes), Date.now(), id]);

        return this.getProcessById(id);
    }

    /**
     * 更新消息ID列表
     * @param {number} id - 流程ID
     * @param {Array<string>} messageIds - 消息ID列表
     * @returns {Promise<Object>}
     */
    static async updateMessageIds(id, messageIds) {
        const db = dbManager.getDb();
        await db.run(`
            UPDATE processes 
            SET messageIds = ?, updatedAt = ?
            WHERE id = ?
        `, [JSON.stringify(messageIds), Date.now(), id]);

        return this.getProcessById(id);
    }
}

export default ProcessModel; 