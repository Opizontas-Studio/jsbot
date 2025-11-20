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
        this.DB_BATCH_SIZE = 500; // 每批数据库操作的记录数
        this.DELETE_BATCH_SIZE = 100; // 批量更新操作使用批次
        this.EXCLUDED_ROLE_IDS = new Set(); // 排除的身份组ID
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
        logTime(`[身份组同步] 需要新增/激活: ${toAdd.length}, 需要移除(软删除): ${toRemove.length}`);

        // 批量更新数据库
        if (toAdd.length > 0 || toRemove.length > 0) {
            await this._batchUpdateDatabase(toAdd, toRemove);
        }

        const duration = ((Date.now() - guildStartTime) / 1000).toFixed(2);
        logTime(
            `[身份组同步] 服务器 ${guildId} 完成 - ` +
            `耗时: ${duration}s, ` +
            `新增/激活: ${toAdd.length}, ` +
            `移除(软删除): ${toRemove.length}`
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
     * 获取数据库中指定服务器的所有身份组记录（包括非活跃的）
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
                attributes: ['user_id', 'role_id', 'is_active'],
                raw: true
            });
            // 使用 concat 而不是 spread operator 避免栈溢出
            for (const record of records) {
                allRecords.push(record);
            }
        }

        return allRecords;
    }

    /**
     * 计算需要新增和删除的记录
     * @private
     */
    _calculateDiff(currentRoles, dbRoles) {
        const currentSet = new Set(currentRoles.map(r => `${r.user_id}:${r.role_id}`));
        const dbMap = new Map(dbRoles.map(r => [`${r.user_id}:${r.role_id}`, r]));

        const toAdd = [];
        const toRemove = [];

        // 找出需要添加或激活的记录
        for (const role of currentRoles) {
            const key = `${role.user_id}:${role.role_id}`;
            const dbRecord = dbMap.get(key);

            if (!dbRecord) {
                // 数据库中不存在，需要新增
                toAdd.push(role);
            } else if (!dbRecord.is_active) {
                // 数据库中存在但已标记为非活跃，需要重新激活
                toAdd.push(role);
            }
        }

        // 找出需要软删除的记录
        for (const role of dbRoles) {
            const key = `${role.user_id}:${role.role_id}`;
            if (!currentSet.has(key) && role.is_active) {
                // 当前用户没有该角色，但数据库中是活跃状态，需要软删除
                toRemove.push({
                    user_id: role.user_id,
                    role_id: role.role_id
                });
            }
        }

        return { toAdd, toRemove };
    }

    /**
     * 批量更新数据库
     * @private
     */
    async _batchUpdateDatabase(toAdd, toRemove) {
        const models = pgManager.getModels();
        
        await pgManager.transaction(async (t) => {
            // 分批插入或更新新记录（Upsert）
            if (toAdd.length > 0) {
                for (let i = 0; i < toAdd.length; i += this.DB_BATCH_SIZE) {
                    const batch = toAdd.slice(i, i + this.DB_BATCH_SIZE);
                    
                    // 构建 upsert 数据：如果存在则更新 is_active=true 和 updated_at
                    const upsertData = batch.map(r => ({
                        user_id: r.user_id,
                        role_id: r.role_id,
                        is_active: true,
                        updated_at: new Date()
                    }));

                    await models.UserRoles.bulkCreate(upsertData, {
                        updateOnDuplicate: ['is_active', 'updated_at'],
                        transaction: t
                    });
                }
            }

            // 分批软删除记录
            if (toRemove.length > 0) {
                for (let i = 0; i < toRemove.length; i += this.DELETE_BATCH_SIZE) {
                    const batch = toRemove.slice(i, i + this.DELETE_BATCH_SIZE);
                    
                    // 使用 OR 条件批量更新
                    const whereConditions = batch.map(r => ({
                        user_id: r.user_id,
                        role_id: r.role_id
                    }));

                    await models.UserRoles.update(
                        { 
                            is_active: false,
                            updated_at: new Date()
                        },
                        {
                            where: {
                                [Op.or]: whereConditions
                            },
                            transaction: t
                        }
                    );
                }
            }
        });
    }
}

export const userRolesSyncService = new UserRolesSyncService();
export default userRolesSyncService;
