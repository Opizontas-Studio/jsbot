import { readFileSync } from 'node:fs';
import { join } from 'path';
import { checkCooldown } from '../handlers/buttons.js';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { handleInteractionError } from '../utils/helper.js';
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
                if (syncGroup.name === '缓冲区') continue;

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
                                sourceServer: sourceMember.guild.name,
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
                                targetServer: guildMember.guild.name,
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
            const syncSummary = syncedRoles
                .map(role => `${role.name}(${role.sourceServer}=>${role.targetServer})`)
                .join('、');
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
                    const rolesToRemove = Array.from(roleIds).filter(roleId => member.roles.cache.has(roleId));

                    if (rolesToRemove.length === 0) {
                        logTime(`[身份同步] 用户 ${member.user.tag} 在服务器 ${guild.name} 没有需要移除的身份组`);
                        continue;
                    }

                    // 一次性移除多个身份组
                    await member.roles.remove(rolesToRemove, reason);
                    successfulServers.push(guild.name);
                    logTime(
                        `[身份同步] 已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的 ${rolesToRemove.length} 个身份组`,
                    );

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
            failedServers,
        };
    } catch (error) {
        logTime(`[身份同步] 批量撤销身份组操作失败: ${error.message}`, true);
        return {
            success: false,
            successfulServers,
            failedServers,
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
                    const rolesToAdd = Array.from(roleIds).filter(roleId => !member.roles.cache.has(roleId));

                    if (rolesToAdd.length === 0) {
                        logTime(`[身份同步] 用户 ${member.user.tag} 在服务器 ${guild.name} 已拥有所有需要添加的身份组`);
                        continue;
                    }

                    // 一次性添加多个身份组
                    await member.roles.add(rolesToAdd, reason);
                    successfulServers.push(guild.name);
                    logTime(
                        `[身份同步] 已在服务器 ${guild.name} 添加用户 ${member.user.tag} 的 ${rolesToAdd.length} 个身份组`,
                    );

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
            failedServers,
        };
    } catch (error) {
        logTime(`[身份同步] 批量添加身份组操作失败: ${error.message}`, true);
        return {
            success: false,
            successfulServers,
            failedServers,
        };
    }
};

/**
 * 处理用户退出议员身份组的请求
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function exitSenatorRole(interaction) {
    try {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('role_exit', interaction.user.id, 60000); // 1分钟冷却
        if (cooldownLeft) {
            await interaction.editReply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次操作`,
            });
            return;
        }

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig || !guildConfig.roleApplication || !guildConfig.roleApplication.senatorRoleId) {
            await interaction.editReply({
                content: '❌ 服务器未正确配置赛博议员身份组',
            });
            return;
        }

        // 检查用户是否有议员身份组
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(guildConfig.roleApplication.senatorRoleId)) {
            await interaction.editReply({
                content: '❌ 您没有赛博议员身份组，无需退出',
            });
            return;
        }

        // 从文件中读取身份组同步配置
        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

        // 查找议员同步组
        const senatorSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '赛博议员');

        if (!senatorSyncGroup) {
            await interaction.editReply({
                content: '❌ 无法找到赛博议员身份组同步配置',
            });
            return;
        }

        // 创建确认按钮
        const confirmEmbed = {
            title: '⚠️ 确认退出赛博议员身份组',
            description: ['您确定要退出所有社区服务器的赛博议员身份组吗？'].join('\n'),
            color: 0xff0000,
        };

        // 显示确认按钮
        await handleConfirmationButton({
            interaction,
            embed: confirmEmbed,
            customId: `confirm_exit_senator_${interaction.user.id}`,
            buttonLabel: '确认退出',
            onConfirm: async confirmation => {
                await confirmation.deferUpdate();

                const result = await revokeRolesByGroups(
                    interaction.client,
                    interaction.user.id,
                    [senatorSyncGroup],
                    '用户自行退出',
                );

                // 根据结果决定显示的消息
                if (result.success) {
                    logTime(
                        `用户 ${interaction.user.tag} 成功退出了赛博议员身份组，已在 ${result.successfulServers.length} 个服务器移除权限`,
                    );

                    await confirmation.editReply({
                        embeds: [
                            {
                                title: '✅ 已退出赛博议员身份组',
                                description: `成功在以下服务器移除赛博议员身份组：\n${result.successfulServers.join('\n')}`,
                                color: 0x00ff00,
                            },
                        ],
                        components: [],
                    });
                } else {
                    logTime(`用户 ${interaction.user.tag} 尝试退出赛博议员身份组失败`, true);

                    await confirmation.editReply({
                        embeds: [
                            {
                                title: '❌ 退出赛博议员身份组失败',
                                description: '操作过程中发生错误，请联系管理员',
                                color: 0xff0000,
                            },
                        ],
                        components: [],
                    });
                }
            },
            onTimeout: async () => {
                await interaction.editReply({
                    embeds: [
                        {
                            title: '❌ 操作已取消',
                            description: '您取消了退出赛博议员身份组的操作',
                            color: 0x808080,
                        },
                    ],
                    components: [],
                });
            },
        });
    } catch (error) {
        logTime(`处理用户退出赛博议员身份组时发生错误: ${error.message}`, true);
        await handleInteractionError(interaction, error);
    }
}
