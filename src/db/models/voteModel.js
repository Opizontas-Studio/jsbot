import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';

class VoteModel {
    /**
     * 创建投票
     * @param {Object} data - 投票数据
     * @param {number} data.processId - 关联的议事流程ID
     * @param {string} data.type - 投票类型 (court/appeal)
     * @param {string} data.redSide - 红方诉求说明
     * @param {string} data.blueSide - 蓝方诉求说明
     * @param {number} data.totalVoters - 总议员数量
     * @param {string} data.messageId - 投票消息ID
     * @param {string} data.threadId - 辩诉帖ID
     * @param {Object} data.details - 执行详情
     * @param {number} data.startTime - 开始时间
     * @param {number} data.endTime - 结束时间
     * @param {number} data.publicTime - 公开时间
     * @returns {Promise<Object>} 创建的投票记录
     */
    static async createVote(data) {
        try {
            const now = Date.now();
            const result = await dbManager.safeExecute(
                'run',
                `INSERT INTO votes (
                    processId, type, redSide, blueSide,
                    totalVoters, redVoters, blueVoters,
                    startTime, endTime, publicTime,
                    status, messageId, threadId,
                    details, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?)`,
                [
                    data.processId,
                    data.type,
                    data.redSide,
                    data.blueSide,
                    data.totalVoters,
                    data.startTime,
                    data.endTime,
                    data.publicTime,
                    data.messageId,
                    data.threadId,
                    JSON.stringify(data.details),
                    now,
                    now,
                ],
            );
            return this.getVoteById(result.lastID);
        } catch (error) {
            logTime(`创建投票失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取投票记录
     * @param {number} id - 投票ID
     * @returns {Promise<Object|null>} 投票记录
     */
    static async getVoteById(id) {
        const cacheKey = `vote_${id}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const vote = await dbManager.safeExecute('get', 'SELECT * FROM votes WHERE id = ?', [id]);
        if (vote) {
            const parsedVote = this._parseVoteJSON(vote);
            dbManager.setCache(cacheKey, parsedVote);
            return parsedVote;
        }

        return null;
    }

    /**
     * 通过流程ID获取投票
     * @param {number} processId - 流程ID
     * @returns {Promise<Object|null>} 投票记录
     */
    static async getVoteByProcessId(processId) {
        const cacheKey = `vote_process_${processId}`;
        const cached = dbManager.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const vote = await dbManager.safeExecute('get', 'SELECT * FROM votes WHERE processId = ?', [processId]);
        if (vote) {
            const parsedVote = this._parseVoteJSON(vote);
            dbManager.setCache(cacheKey, parsedVote);
            return parsedVote;
        }

        return null;
    }

    /**
     * 更新投票状态
     * @param {number} id - 投票ID
     * @param {string} status - 新状态
     * @param {Object} [options] - 更新选项
     * @param {string} [options.result] - 投票结果
     * @returns {Promise<Object>} 更新后的投票记录
     */
    static async updateStatus(id, status, options = {}) {
        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE votes 
                SET status = ?,
                    result = CASE WHEN ? IS NOT NULL THEN ? ELSE result END,
                    updatedAt = ?
                WHERE id = ?`,
                [status, options.result, options.result, Date.now(), id],
            );

            this._clearRelatedCache(id);
            return this.getVoteById(id);
        } catch (error) {
            logTime(`更新投票状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 添加投票人
     * @param {number} id - 投票ID
     * @param {string} userId - 用户ID
     * @param {string} choice - 投票选择 (red/blue)
     * @returns {Promise<Object>} 更新后的投票记录
     */
    static async addVoter(id, userId, choice) {
        try {
            // 获取最新投票状态
            const vote = await this.getVoteById(id);
            if (!vote || vote.status !== 'in_progress') {
                throw new Error('投票已结束或不存在');
            }

            const votersField = choice === 'red' ? 'redVoters' : 'blueVoters';
            const oppositeField = choice === 'red' ? 'blueVoters' : 'redVoters';

            // 获取当前投票者列表
            const currentVoters = vote[votersField];
            const oppositeVoters = vote[oppositeField];

            // 如果已经投过同一选项，则移除
            const hasVoted = currentVoters.includes(userId);
            let updatedVoters = hasVoted ? currentVoters.filter(id => id !== userId) : [...currentVoters, userId];

            // 如果在对方列表中，也要移除
            const updatedOppositeVoters = oppositeVoters.filter(id => id !== userId);

            // 使用 dbManager.transaction 方法
            await dbManager.transaction(async () => {
                await dbManager.safeExecute(
                    'run',
                    `UPDATE votes 
                    SET ${votersField} = ?,
                        ${oppositeField} = ?,
                        updatedAt = ?
                    WHERE id = ?`,
                    [JSON.stringify(updatedVoters), JSON.stringify(updatedOppositeVoters), Date.now(), id],
                );
            });

            // 清除缓存
            this._clearRelatedCache(id);

            // 获取并返回最新状态
            const updatedVote = await this.getVoteById(id);
            if (!updatedVote) {
                throw new Error('无法获取更新后的投票状态');
            }
            return updatedVote;
        } catch (error) {
            logTime(`添加投票人失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 解析投票记录的JSON字段
     * @private
     * @param {Object} vote - 投票记录
     * @returns {Object} 处理后的投票记录
     */
    static _parseVoteJSON(vote) {
        if (!vote) return null;

        return {
            ...vote,
            redVoters: JSON.parse(vote.redVoters || '[]'),
            blueVoters: JSON.parse(vote.blueVoters || '[]'),
            details: JSON.parse(vote.details || '{}'),
        };
    }

    /**
     * 清除相关缓存
     * @private
     * @param {number} voteId - 投票ID
     */
    static _clearRelatedCache(voteId) {
        dbManager.clearCache(`vote_${voteId}`);
        // 获取processId并清除相关缓存
        this.getVoteById(voteId).then(vote => {
            if (vote?.processId) {
                dbManager.clearCache(`vote_process_${vote.processId}`);
                // 添加对相关消息的缓存清理
                dbManager.clearCache(`vote_message_${vote.messageId}`);
            }
        });
    }
}

export { VoteModel };
