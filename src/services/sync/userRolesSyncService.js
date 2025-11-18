import { pgManager } from '../../pg/pgManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

/**
 * 身份组同步服务
 * 同步所有用户的身份组关系到 user_roles 表
 */
class UserRolesSyncService {
    constructor() {
        // 配置参数
        this.DB_BATCH_SIZE = 5000; // 每批数据库操作的记录数
        this.EXCLUDED_ROLE_IDS = new Set(); // 排除的身份组ID（可配置）
    }

    /**
     * 同步创作者身份组
     */
    async syncCreatorRoles(client) {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    logTime('[身份组同步] PostgreSQL未连接，跳过同步');
                    return { success: false };
                }

                const results = [];
                for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
                    const creatorRoleId = guildConfig.roleApplication?.creatorRoleId;
                    if (!creatorRoleId) continue;

                    const result = await this._syncGuildCreatorRole(client, guildId, creatorRoleId);
                    results.push(result);
                }

                const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
                const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);

                logTime(`[身份组同步] 完成 - 新增: ${totalAdded}, 移除: ${totalRemoved}`);
                return { added: totalAdded, removed: totalRemoved };
            },
            '同步创作者身份组'
        );
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
        return await ErrorHandler.handleService(
            async () => {
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
            },
            `同步服务器 ${guildId} 的所有身份组`,
            { throwOnError: true }
        );
    }

    /**
     * 从成员集合中提取所有身份组关系
     * @private
     */
    _extractUserRoles(members, guildId) {
        const roles = [];
        
        members.forEach(member => {
            // 跳过机器人
            if (member.user.bot) return;

            // 遍历成员的所有身份组
            member.roles.cache.forEach(role => {
                // 跳过 @everyone 角色（ID 等于服务器ID）
                if (role.id === guildId) return;
                
                // 跳过被排除的身份组
                if (this.EXCLUDED_ROLE_IDS.has(role.id)) return;

                roles.push({
                    user_id: member.user.id,
                    role_id: role.id
                });
            });
        });

        return roles;
    }

    /**
     * 获取数据库中指定服务器的所有身份组记录
     * @private
     */
    async _fetchDbRolesForGuild(guild) {
        // 先获取该服务器的所有角色ID
        const guildRoleIds = Array.from(guild.roles.cache.keys());
        
        if (guildRoleIds.length === 0) {
            return [];
        }

        // 查询数据库中属于这些角色的所有记录
        const models = pgManager.getModels();
        
        // 分批查询以避免SQL参数过多
        const QUERY_BATCH_SIZE = 1000;
        const allRecords = [];

        for (let i = 0; i < guildRoleIds.length; i += QUERY_BATCH_SIZE) {
            const batchRoleIds = guildRoleIds.slice(i, i + QUERY_BATCH_SIZE);
            
            const records = await models.UserRoles.findAll({
                where: {
                    role_id: batchRoleIds
                },
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
        // 构建当前身份组关系的Set（用于快速查找，O(1)）
        const currentSet = new Set(
            currentRoles.map(r => `${r.user_id}:${r.role_id}`)
        );

        // 构建数据库身份组关系的Set
        const dbSet = new Set(
            dbRoles.map(r => `${r.user_id}:${r.role_id}`)
        );

        // 需要新增的：在当前但不在数据库中
        const toAdd = currentRoles.filter(r => !dbSet.has(`${r.user_id}:${r.role_id}`));

        // 需要删除的：在数据库但不在当前中
        const toRemove = dbRoles.filter(r => !currentSet.has(`${r.user_id}:${r.role_id}`));

        return { toAdd, toRemove };
    }

    /**
     * 批量更新数据库（使用原生SQL优化）
     * @private
     */
    async _batchUpdateDatabase(toAdd, toRemove) {
        await pgManager.transaction(async (t) => {
            // 分批插入新记录
            if (toAdd.length > 0) {
                //logTime(`[身份组同步] 开始分批插入 ${toAdd.length} 条记录...`);
                for (let i = 0; i < toAdd.length; i += this.DB_BATCH_SIZE) {
                    const batch = toAdd.slice(i, i + this.DB_BATCH_SIZE);
                    
                    // 使用原生SQL的 INSERT ... ON CONFLICT DO NOTHING
                    const values = batch
                        .map(r => `(${r.user_id}, ${r.role_id})`)
                        .join(',');
                    
                    const insertQuery = `
                        INSERT INTO user_roles (user_id, role_id)
                        VALUES ${values}
                        ON CONFLICT (user_id, role_id) DO NOTHING
                    `;

                    await pgManager.sequelize.query(insertQuery, { transaction: t });
                    
                    //logTime(`[身份组同步] 已插入批次 ${Math.floor(i / this.DB_BATCH_SIZE) + 1}/${Math.ceil(toAdd.length / this.DB_BATCH_SIZE)}`);
                }
            }

            // 分批删除记录
            if (toRemove.length > 0) {
                //logTime(`[身份组同步] 开始分批删除 ${toRemove.length} 条记录...`);
                for (let i = 0; i < toRemove.length; i += this.DB_BATCH_SIZE) {
                    const batch = toRemove.slice(i, i + this.DB_BATCH_SIZE);
                    
                    // 使用原生SQL批量删除
                    const conditions = batch
                        .map(r => `(user_id = ${r.user_id} AND role_id = ${r.role_id})`)
                        .join(' OR ');
                    
                    const deleteQuery = `
                        DELETE FROM user_roles
                        WHERE ${conditions}
                    `;

                    await pgManager.sequelize.query(deleteQuery, { transaction: t });
                    
                    //logTime(`[身份组同步] 已删除批次 ${Math.floor(i / this.DB_BATCH_SIZE) + 1}/${Math.ceil(toRemove.length / this.DB_BATCH_SIZE)}`);
                }
            }
        });
    }

    /**
     * 同步单个服务器的创作者身份组
     * @private
     */
    async _syncGuildCreatorRole(client, guildId, roleId) {
        return await ErrorHandler.handleService(
            async () => {
                // 获取服务器成员
                const guild = await client.guilds.fetch(guildId);
                const members = await guild.members.fetch({
                    time: 180000, // 3分钟超时
                    force: true // 强制从 API 获取，不使用缓存
                });

                // 过滤出拥有创作者身份的成员
                const currentCreators = members
                    .filter(member => !member.user.bot && member.roles.cache.has(roleId))
                    .map(member => ({
                        user_id: member.user.id,
                        role_id: roleId
                    }));

                // 获取数据库中的记录
                const models = pgManager.getModels();
                const dbRecords = await models.UserRoles.findAll({
                    where: { role_id: roleId },
                    raw: true
                });

                const dbUserIds = new Set(dbRecords.map(r => r.user_id));
                const currentUserIds = new Set(currentCreators.map(c => c.user_id));

                // 计算差异
                const toAdd = currentCreators.filter(c => !dbUserIds.has(c.user_id));
                const toRemove = dbRecords.filter(r => !currentUserIds.has(r.user_id));

                // 批量更新
                await pgManager.transaction(async (t) => {
                    // 新增
                    if (toAdd.length > 0) {
                        await models.UserRoles.bulkCreate(toAdd, { 
                            transaction: t,
                            ignoreDuplicates: true 
                        });
                    }

                    // 移除
                    if (toRemove.length > 0) {
                        await models.UserRoles.destroy({
                            where: {
                                user_id: toRemove.map(r => r.user_id),
                                role_id: roleId
                            },
                            transaction: t
                        });
                    }
                });

                return { 
                    guildId, 
                    added: toAdd.length, 
                    removed: toRemove.length,
                    total: currentCreators.length
                };
            },
            `同步服务器 ${guildId} 的创作者身份组`,
            { throwOnError: true }
        );
    }
}

export const userRolesSyncService = new UserRolesSyncService();
export default userRolesSyncService;

