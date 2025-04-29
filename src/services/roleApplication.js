import { readFileSync } from 'node:fs';
import { join } from 'path';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

/**
 * 同步用户的身份组
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {boolean} [isAutoSync=false] - 是否为自动同步（加入服务器时）
 * @returns {Promise<{syncedRoles: Array<{name: string, sourceServer: string, targetServer: string}>}>}
 */
export const syncMemberRoles = async (member, isAutoSync = false) => {
    try {
        // 读取身份组同步配置
        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
        const syncedRoles = [];
        const guildRolesMap = new Map(); // Map<guildId, Set<roleId>>
        const guildSyncGroups = new Map(); // Map<guildId, Map<roleId, {name, sourceServer}>>

        await globalRequestQueue.add(async () => {
            // 获取所有服务器的成员信息
            const memberCache = new Map();
            for (const guild of member.client.guilds.cache.values()) {
                try {
                    const guildMember = await guild.members.fetch(member.user.id);
                    memberCache.set(guild.id, guildMember);
                    guildRolesMap.set(guild.id, new Set());
                    guildSyncGroups.set(guild.id, new Map());
                } catch (error) {
                    continue;
                }
            }

            // 遍历每个同步组
            for (const syncGroup of roleSyncConfig.syncGroups) {
                // 跳过"缓冲区"同步组
                if (syncGroup.name === "缓冲区") continue;

                // 检查当前服务器是否有此同步组的配置
                const currentGuildRoleId = syncGroup.roles[member.guild.id];
                if (!currentGuildRoleId) continue;

                // 检查其他服务器中是否有该身份组
                for (const [guildId, roleId] of Object.entries(syncGroup.roles)) {
                    if (guildId === member.guild.id) continue;

                    const sourceMember = memberCache.get(guildId);
                    if (sourceMember?.roles.cache.has(roleId)) {
                        // 如果其他服务器有这个身份组，且当前服务器没有，则添加到同步列表
                        if (!member.roles.cache.has(currentGuildRoleId)) {
                            guildRolesMap.get(member.guild.id)?.add(currentGuildRoleId);
                            guildSyncGroups.get(member.guild.id)?.set(currentGuildRoleId, {
                                name: syncGroup.name,
                                sourceServer: sourceMember.guild.name
                            });
                        }
                        break;
                    }
                }
            }

            // 批量处理每个服务器的身份组同步
            for (const [guildId, rolesToAdd] of guildRolesMap) {
                if (rolesToAdd.size === 0) continue;

                const guildMember = memberCache.get(guildId);
                if (!guildMember) continue;

                try {
                    const roleArray = Array.from(rolesToAdd);
                    // 一次性添加所有身份组
                    await guildMember.roles.add(roleArray, '身份组同步');

                    // 记录同步结果
                    for (const roleId of roleArray) {
                        const syncInfo = guildSyncGroups.get(guildId)?.get(roleId);
                        if (syncInfo) {
                            syncedRoles.push({
                                name: syncInfo.name,
                                sourceServer: syncInfo.sourceServer,
                                targetServer: guildMember.guild.name
                            });
                        }
                    }

                    // 添加API请求延迟
                    await delay(500);
                } catch (error) {
                    logTime(`同步用户 ${member.user.tag} 在服务器 ${guildId} 的身份组失败: ${error.message}`, true);
                }
            }
        }, 2);

        // 记录日志
        if (syncedRoles.length > 0) {
            const syncSummary = syncedRoles.map(role =>
                `${role.name}(${role.sourceServer}=>${role.targetServer})`
            ).join('、');
            logTime(`${isAutoSync ? '[自动同步] ' : '[手动同步] '}用户 ${member.user.tag} 同步结果：${syncSummary}`);
        } else {
            logTime(`${isAutoSync ? '[自动同步] ' : '[手动同步] '}用户 ${member.user.tag} 无需同步任何身份组`);
        }

        return { syncedRoles };
    } catch (error) {
        logTime(`处理用户 ${member.user.tag} 的身份组同步时发生错误: ${error.message}`, true);
        throw error;
    }
};

/**
 * 批量撤销用户的多个同步组身份组
 * @param {Object} client - Discord客户端
 * @param {string} userId - 目标用户ID
 * @param {Array<Object>} syncGroups - 要撤销的同步组配置数组
 * @param {string} reason - 撤销原因
 * @returns {Promise<{success: boolean, successfulServers: string[], failedServers: Array<{id: string, name: string}>}>}
 */
export const revokeRolesByGroups = async (client, userId, syncGroups, reason) => {
    const successfulServers = [];
    const failedServers = [];

    try {
        // 收集所有需要处理的服务器和对应的身份组
        const guildRolesMap = new Map(); // Map<guildId, Set<roleId>>

        for (const syncGroup of syncGroups) {
            for (const [guildId, roleId] of Object.entries(syncGroup.roles)) {
                if (!guildRolesMap.has(guildId)) {
                    guildRolesMap.set(guildId, new Set());
                }
                guildRolesMap.get(guildId).add(roleId);
            }
        }

        // 批量处理每个服务器
        await globalRequestQueue.add(async () => {
            for (const [guildId, roleIds] of guildRolesMap) {
                try {
                    // 获取服务器信息
                    const guild = await client.guilds.fetch(guildId);
                    if (!guild) {
                        failedServers.push({ id: guildId, name: guildId });
                        continue;
                    }

                    // 获取成员信息
                    const member = await guild.members.fetch(userId);
                    if (!member) {
                        logTime(`[身份同步] 用户 ${userId} 不在服务器 ${guild.name} 中`);
                        continue;
                    }

                    // 检查用户实际拥有的需要移除的身份组
                    const rolesToRemove = Array.from(roleIds).filter(roleId =>
                        member.roles.cache.has(roleId)
                    );

                    if (rolesToRemove.length === 0) {
                        logTime(`[身份同步] 用户 ${member.user.tag} 在服务器 ${guild.name} 没有需要移除的身份组`);
                        continue;
                    }

                    // 一次性移除多个身份组
                    await member.roles.remove(rolesToRemove, reason);
                    successfulServers.push(guild.name);
                    logTime(`[身份同步] 已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的 ${rolesToRemove.length} 个身份组`);

                    // 添加API请求延迟
                    await delay(500);

                } catch (error) {
                    logTime(`在服务器 ${guildId} 移除身份组失败: ${error.message}`, true);
                    failedServers.push({ id: guildId, name: guildId });
                }
            }
        }, 2); // 优先级2，较低优先级

        return {
            success: successfulServers.length > 0,
            successfulServers,
            failedServers
        };
    } catch (error) {
        logTime(`[身份同步] 批量撤销身份组操作失败: ${error.message}`, true);
        return {
            success: false,
            successfulServers,
            failedServers
        };
    }
};

/**
 * 批量添加用户的多个同步组身份组
 * @param {Object} client - Discord客户端
 * @param {string} userId - 目标用户ID
 * @param {Array<Object>} syncGroups - 要添加的同步组配置数组
 * @param {string} reason - 添加原因
 * @returns {Promise<{success: boolean, successfulServers: string[], failedServers: Array<{id: string, name: string}>}>}
 */
export const addRolesByGroups = async (client, userId, syncGroups, reason) => {
    const successfulServers = [];
    const failedServers = [];

    try {
        // 收集所有需要处理的服务器和对应的身份组
        const guildRolesMap = new Map(); // Map<guildId, Set<roleId>>

        for (const syncGroup of syncGroups) {
            for (const [guildId, roleId] of Object.entries(syncGroup.roles)) {
                if (!guildRolesMap.has(guildId)) {
                    guildRolesMap.set(guildId, new Set());
                }
                guildRolesMap.get(guildId).add(roleId);
            }
        }

        // 批量处理每个服务器
        await globalRequestQueue.add(async () => {
            for (const [guildId, roleIds] of guildRolesMap) {
                try {
                    // 获取服务器信息
                    const guild = await client.guilds.fetch(guildId);
                    if (!guild) {
                        failedServers.push({ id: guildId, name: guildId });
                        continue;
                    }

                    // 获取成员信息
                    const member = await guild.members.fetch(userId);
                    if (!member) {
                        logTime(`用户 ${userId} 不在服务器 ${guild.name} 中`, true);
                        continue;
                    }

                    // 检查用户未拥有的需要添加的身份组
                    const rolesToAdd = Array.from(roleIds).filter(roleId =>
                        !member.roles.cache.has(roleId)
                    );

                    if (rolesToAdd.length === 0) {
                        logTime(`[身份同步] 用户 ${member.user.tag} 在服务器 ${guild.name} 已拥有所有需要添加的身份组`);
                        continue;
                    }

                    // 一次性添加多个身份组
                    await member.roles.add(rolesToAdd, reason);
                    successfulServers.push(guild.name);
                    logTime(`[身份同步] 已在服务器 ${guild.name} 添加用户 ${member.user.tag} 的 ${rolesToAdd.length} 个身份组`);

                    // 添加API请求延迟
                    await delay(500);

                } catch (error) {
                    logTime(`[身份同步] 在服务器 ${guildId} 添加身份组失败: ${error.message}`, true);
                    failedServers.push({ id: guildId, name: guildId });
                }
            }
        }, 2); // 优先级2，较低优先级

        return {
            success: successfulServers.length > 0,
            successfulServers,
            failedServers
        };
    } catch (error) {
        logTime(`[身份同步] 批量添加身份组操作失败: ${error.message}`, true);
        return {
            success: false,
            successfulServers,
            failedServers
        };
    }
};
