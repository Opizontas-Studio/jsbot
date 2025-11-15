import { pgManager } from '../../pg/pgManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

/**
 * 身份组同步服务
 * 每小时同步一次创作者身份组成员到 user_roles 表
 */
class UserRolesSyncService {
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

