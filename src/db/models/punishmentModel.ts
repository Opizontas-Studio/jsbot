import { Assert } from '../../utils/assertion.js';
import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';
import { Sqlited } from '../sqlited.js';

export namespace PunishmentModel {
    export type PunishmentType = 'ban' | 'mute';
    export type PunishmentStatus = 'active' | 'expired' | 'appealed' | 'revoked';
    export interface Punishment {
        id: number;
        userId: string;
        type: PunishmentType;
        reason: string;
        duration: number; // 处罚时长(毫秒)，永封为-1
        warningDuration: number;
        executorId: string;
        status: PunishmentStatus;
        synced: number;
        syncedServers: string[];
        keepMessages: boolean;
        channelId: string;
        createdAt: number;
        updatedAt: number;
    }

    interface CreatePunishmentParam {
        userId: string;
        type: PunishmentType;
        reason: string;
        duration: number;
        warningDuration?: number;
        executorId: string;
        keepMessages?: boolean;
        channelId: string;
    }

    /**
     * 创建新的处罚记录
     * @param data - 处罚数据
     * @returns 处罚记录
     */
    export async function createPunishment(data: CreatePunishmentParam): Promise<Punishment> {
        const {
            userId,
            type,
            reason,
            duration,
            warningDuration = null,
            executorId,
            keepMessages = false,
            channelId,
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
                [userId, type, reason, duration, warningDuration, executorId, keepMessages, channelId],
            );
            if (!result.lastID) {
                throw new Error(`执行 INSERT 命令失败`);
            }

            return getPunishmentById(result.lastID);
        } catch (error) {
            Assert.isError(error);
            logTime(`创建处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取处罚记录
     * @param id - 处罚ID
     * @returns 处罚记录
     */
    export async function getPunishmentById(id: number): Promise<Punishment> {
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
     * @param userId - 用户ID
     * @param includeExpired - 是否包含已过期记录
     * @returns 处罚记录列表
     */
    export async function getUserPunishments(userId: string, includeExpired: boolean = false): Promise<Punishment[]> {
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

        const params: any[] = [userId];
        if (!includeExpired) {
            params.push(now);
        }

        const punishments: Sqlited<Punishment>[] = await dbManager.safeExecute('all', query, params);

        const processedPunishments = punishments.map(p => ({
            ...p,
            syncedServers: JSON.parse(p.syncedServers),
            keepMessages: Boolean(p.keepMessages),
        })) as unknown as Punishment[]; // FIXME: 未经检查的类型转换，需要将数据库中 boolean 用 TEXT 表示，然后写一个类型转换函数

        dbManager.setCache(cacheKey, processedPunishments);
        return processedPunishments;
    }

    /**
     * 更新处罚状态
     * @param id - 处罚ID
     * @param status - 新状态
     * @param reason - 状态更新原因
     * @returns 更新后的处罚记录
     */
    export async function updateStatus(id: number, status: PunishmentStatus, reason?: string): Promise<Punishment> {
        const punishment = await getPunishmentById(id);
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
            _clearRelatedCache(punishment.userId, id);

            return getPunishmentById(id);
        } catch (error) {
            Assert.isError(error);
            logTime(`更新处罚状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新同步状态
     * @param id - 处罚ID
     * @param syncedServers - 已同步的服务器ID列表
     * @returns 更新后的处罚记录
     */
    export async function updateSyncStatus(id: number, syncedServers: string[]): Promise<Punishment> {
        const punishment = await getPunishmentById(id);
        if (!punishment) {
            throw new Error('处罚记录不存在');
        }

        try {
            await dbManager.safeExecute(
                'run',
                `UPDATE punishments 
	            SET synced = ?, syncedServers = ?, updatedAt = ?
	            WHERE id = ?`,
                [1, JSON.stringify(syncedServers), Date.now(), id],
            );

            // 使用修改后的清除缓存函数
            _clearRelatedCache(punishment.userId, id);

            return getPunishmentById(id);
        } catch (error) {
            Assert.isError(error);
            logTime(`更新同步状态失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 清除相关缓存
     * @param userId - 用户ID
     * @param punishmentId - 处罚ID（可选）
     */
    function _clearRelatedCache(userId: string, punishmentId?: number): void {
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
     * @param includeExpired - 是否包含已过期记录
     * @returns 处罚记录列表
     */
    export async function getAllPunishments(includeExpired: boolean = false): Promise<Punishment[]> {
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

            const punishments: Sqlited<Punishment>[] = await dbManager.safeExecute(
                'all',
                query,
                !includeExpired ? [now] : [],
            );

            return punishments.map(p => ({
                ...p,
                syncedServers: JSON.parse(p.syncedServers),
                keepMessages: Boolean(p.keepMessages),
            })) as unknown as Punishment[]; // FIXME: 未经检查的类型转换，需要将数据库中 boolean 用 TEXT 表示，然后写一个类型转换函数
        } catch (error) {
            Assert.isError(error);
            logTime(`获取全库处罚记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 删除处罚记录
     * @param id - 处罚ID
     * @returns 删除是否成功
     */
    export async function deletePunishment(id: number): Promise<boolean> {
        try {
            const punishment = await getPunishmentById(id);
            if (!punishment) {
                throw new Error('处罚记录不存在');
            }

            await dbManager.safeExecute('run', 'DELETE FROM punishments WHERE id = ?', [id]);

            // 清除相关缓存
            _clearRelatedCache(punishment.userId, id);

            return true;
        } catch (error) {
            Assert.isError(error);
            logTime(`删除处罚记录失败: ${error.message}`, true);
            return false;
        }
    }
}
