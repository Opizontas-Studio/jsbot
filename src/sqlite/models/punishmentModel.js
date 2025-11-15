import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';
import { BaseModel } from './BaseModel.js';

class PunishmentModel extends BaseModel {
    static get tableName() {
        return 'punishments';
    }

    static get arrayFields() {
        return ['syncedServers'];
    }

    static get booleanFields() {
        return ['keepMessages'];
    }

    static get numberFields() {
        return ['duration', 'warningDuration'];
    }

    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @param {string} data.userId - 被处罚用户ID
     * @param {string} data.type - 处罚类型 (ban/mute/softban/warning)
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
                `INSERT INTO punishments (
                    userId, type, reason, duration, warningDuration,
                    executorId, status, keepMessages, channelId
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                [userId, type, reason, duration, warningDuration, executorId, keepMessages ? 1 : 0, channelId],
            );

            return this.getPunishmentById(result.lastID);
        } catch (error) {
            logTime(`[处罚系统] 创建处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取处罚记录
     * @param {number} id - 处罚ID
     * @returns {Promise<Object>} 处罚记录
     */
    static async getPunishmentById(id) {
        return this.findById(id);
    }

    /**
     * 获取用户的处罚历史
     * @param {string} userId - 用户ID
     * @param {boolean} [includeExpired=false] - 是否包含已过期记录
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getUserPunishments(userId, includeExpired = false) {
        const cacheKey = this.getCacheKey(`user_${userId}_${includeExpired}`);
        const cached = this.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const now = Date.now();
        let where = 'userId = ?';
        const params = [userId];

        if (!includeExpired) {
            where += ` AND status = 'active' AND (duration = -1 OR createdAt + duration > ?)`;
            params.push(now);
        }

        const punishments = await this.findAll(where, params, { cacheKey });
        return punishments;
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
            logTime(`[处罚系统] 正在更新处罚状态: ID=${id}, 旧状态=${punishment.status}, 新状态=${status}`);

            const updates = { status, updatedAt: Date.now() };
            if (reason) {
                updates.statusReason = reason;
            }

            await dbManager.safeExecute(
                'run',
                `UPDATE punishments
                SET status = ?, statusReason = CASE WHEN ? IS NOT NULL THEN ? ELSE statusReason END,
                updatedAt = ?
                WHERE id = ?`,
                [status, reason, reason, Date.now(), id],
            );

            this._clearRelatedCache(punishment.userId, id);
            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`[处罚系统] 更新处罚状态失败: ${error.message}`, true);
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
            await this.update(id, {
                syncedServers: JSON.stringify(syncedServers),
            });

            this._clearRelatedCache(punishment.userId, id);
            return this.getPunishmentById(id);
        } catch (error) {
            logTime(`[处罚系统] 更新处罚 ${id} 的同步状态失败: ${error.message}`, true);
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
        this.clearCache(this.getCacheKey(`active_${userId}`));
        this.clearCache(this.getCacheKey(`user_${userId}_true`));
        this.clearCache(this.getCacheKey(`user_${userId}_false`));

        // 如果提供了处罚ID，清除特定处罚的缓存
        if (punishmentId) {
            this.clearCache(this.getCacheKey(punishmentId));
        }
    }

    /**
     * 获取所有处罚记录
     * @param {boolean} [includeExpired=false] - 是否包含已过期记录
     * @returns {Promise<Array>} 处罚记录列表
     */
    static async getAllPunishments(includeExpired = false) {
        try {
            const where = includeExpired ? '' : `status = 'active'`;
            const punishments = await this.findAll(where);

            // 添加 targetId 别名以兼容旧代码
            return punishments.map(p => ({
                ...p,
                targetId: p.userId,
            }));
        } catch (error) {
            logTime(`[处罚系统] 获取全库处罚记录失败: ${error.message}`, true);
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

            const success = await this.delete(id);

            if (success) {
                this._clearRelatedCache(punishment.userId, id);
            }

            return success;
        } catch (error) {
            logTime(`[处罚系统] 删除处罚记录失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 更新处罚通知信息
     * @param {number} id - 处罚ID
     * @param {string} messageId - 消息ID
     * @param {string} guildId - 服务器ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    static async updateNotificationInfo(id, messageId, guildId) {
        try {
            await this.update(id, {
                notificationMessageId: messageId,
                notificationGuildId: guildId,
            });

            this._clearRelatedCache(null, id);
            return true;
        } catch (error) {
            logTime(`[处罚系统] 更新处罚通知信息失败: ${error.message}`, true);
            return false;
        }
    }
}

export { PunishmentModel };
