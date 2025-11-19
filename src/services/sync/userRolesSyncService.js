import { pgManager } from '../../pg/pgManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { Op } from 'sequelize';

/**
 * 身份组同步服务
 * 同步所有用户的身份组关系到 user_roles 表
 */
class UserRolesSyncService {
    constructor() {
        this.DB_BATCH_SIZE = 1000; // 每批数据库操作的记录数
        this.EXCLUDED_ROLE_IDS = new Set(); // 排除的身份组ID（可配置）
    }

    /**
     * 同步所有用户的所有身份组
     */
    async syncAllUserRoles(client) {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    logTime('[身份组同步] PostgreSQL未连接，跳过同步');
                    return { success: false };
                }

                const startTime = Date.now();
                const results = [];

                for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
                    const result = await this._syncGuildAllRoles(client, guildId);
                    results.push(result);
                }

                const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
                const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
                const totalMembers = results.reduce((sum, r) => sum + r.memberCount, 0);
                const totalRoles = results.reduce((sum, r) => sum + r.totalRoles, 0);

                const duration = ((Date.now() - startTime) / 1000).toFixed(2);

                return {
                    success: true,
                    added: totalAdded,
                    removed: totalRemoved,
                    totalMembers,
                    totalRoles,
                    duration: parseFloat(duration)
                };
            },
            '同步所有用户身份组'
        );
    }

    /**
     * 同步单个服务器的所有身份组
     * @private
     */
    async _syncGuildAllRoles(client, guildId) {
        const guildStartTime = Date.now();
        const guild = await client.guilds.fetch(guildId);

        // 获取所有成员（Discord.js 自动处理分页和限流）
        const allMembers = await guild.members.fetch({ force: true });
        logTime(`[身份组同步] 成功获取 ${allMembers.size} 个成员`);

        // 提取所有身份组关系（排除机器人和@everyone角色）
        const currentRoles = this._extractUserRoles(allMembers, guildId);
        logTime(`[身份组同步] 提取到 ${currentRoles.length} 条身份组关系`);

        // 获取数据库中该服务器的所有角色记录
        const dbRoles = await this._fetchDbRolesForGuild(guild);
        logTime(`[身份组同步] 数据库中有 ${dbRoles.length} 条记录`);

        // 计算差异
        const { toAdd, toRemove } = this._calculateDiff(currentRoles, dbRoles);
        logTime(`[身份组同步] 需要新增: ${toAdd.length}, 需要移除: ${toRemove.length}`);

        // 批量更新数据库
        if (toAdd.length > 0 || toRemove.length > 0) {
            await this._batchUpdateDatabase(toAdd, toRemove);
        }

        const duration = ((Date.now() - guildStartTime) / 1000).toFixed(2);
        logTime(
            `[身份组同步] 服务器 ${guildId} 完成 - ` +
            `耗时: ${duration}s, ` +
            `新增: ${toAdd.length}, ` +
            `移除: ${toRemove.length}`
        );

        return {
            guildId,
            memberCount: allMembers.size,
            totalRoles: currentRoles.length,
            added: toAdd.length,
            removed: toRemove.length,
            duration: parseFloat(duration)
        };
    }

    /**
     * 从成员集合中提取所有身份组关系
     * @private
     */
    _extractUserRoles(members, guildId) {
        const roles = [];
        
        for (const member of members.values()) {
            if (member.user.bot) continue;

            for (const role of member.roles.cache.values()) {
                // 跳过 @everyone 角色和被排除的身份组
                if (role.id === guildId || this.EXCLUDED_ROLE_IDS.has(role.id)) continue;
                
                roles.push({
                    user_id: member.user.id,
                    role_id: role.id
                });
            }
        }

        return roles;
    }

    /**
     * 获取数据库中指定服务器的所有身份组记录
     * @private
     */
    async _fetchDbRolesForGuild(guild) {
        const guildRoleIds = Array.from(guild.roles.cache.keys());
        if (guildRoleIds.length === 0) return [];

        const models = pgManager.getModels();
        const allRecords = [];
        const QUERY_BATCH_SIZE = 1000;

        for (let i = 0; i < guildRoleIds.length; i += QUERY_BATCH_SIZE) {
            const batchRoleIds = guildRoleIds.slice(i, i + QUERY_BATCH_SIZE);
            const records = await models.UserRoles.findAll({
                where: { role_id: batchRoleIds },
                attributes: ['user_id', 'role_id'],
                raw: true
            });
            allRecords.push(...records);
        }

        return allRecords;
    }

    /**
     * 计算需要新增和删除的记录
     * @private
     */
    _calculateDiff(currentRoles, dbRoles) {
        const currentSet = new Set(currentRoles.map(r => `${r.user_id}:${r.role_id}`));
        const dbSet = new Set(dbRoles.map(r => `${r.user_id}:${r.role_id}`));

        const toAdd = currentRoles.filter(r => !dbSet.has(`${r.user_id}:${r.role_id}`));
        const toRemove = dbRoles.filter(r => !currentSet.has(`${r.user_id}:${r.role_id}`));

        return { toAdd, toRemove };
    }

    /**
     * 批量更新数据库（使用参数化查询避免栈溢出）
     * @private
     */
    async _batchUpdateDatabase(toAdd, toRemove) {
        const models = pgManager.getModels();
        
        await pgManager.transaction(async (t) => {
            // 分批插入新记录
            if (toAdd.length > 0) {
                for (let i = 0; i < toAdd.length; i += this.DB_BATCH_SIZE) {
                    const batch = toAdd.slice(i, i + this.DB_BATCH_SIZE);
                    
                    // 使用 bulkCreate 的参数化查询，避免 SQL 拼接
                    await models.UserRoles.bulkCreate(batch, {
                        transaction: t,
                        ignoreDuplicates: true // 相当于 ON CONFLICT DO NOTHING
                    });
                }
            }

            // 分批删除记录
            if (toRemove.length > 0) {
                for (let i = 0; i < toRemove.length; i += this.DB_BATCH_SIZE) {
                    const batch = toRemove.slice(i, i + this.DB_BATCH_SIZE);
                    
                    // 使用 destroy 的参数化查询，避免 SQL 拼接
                    // 构建 OR 条件数组
                    await models.UserRoles.destroy({
                        where: {
                            [Op.or]: batch.map(r => ({
                                user_id: r.user_id,
                                role_id: r.role_id
                            }))
                        },
                        transaction: t
                    });
                }
            }
        });
    }
}

export const userRolesSyncService = new UserRolesSyncService();
export default userRolesSyncService;

