import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { checkCooldown } from '../handlers/buttons.js';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');
const opinionRecordsPath = join(process.cwd(), 'data', 'opinionRecords.json');

/**
 * 读取身份组同步配置
 * @returns {Object} 身份组同步配置对象
 */
export const getRoleSyncConfig = () => {
    try {
        return JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
    } catch (error) {
        logTime(`[身份同步] 读取身份组同步配置失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 同步用户的身份组
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {boolean} [isAutoSync=false] - 是否为自动同步（加入服务器时）
 * @returns {Promise<{syncedRoles: Array<{name: string, sourceServer: string, targetServer: string}>}>}
 */
export const syncMemberRoles = async (member, isAutoSync = false) => {
    try {
        // 读取身份组同步配置
        const roleSyncConfig = getRoleSyncConfig();
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
                // 跳过"缓冲区"和"被警告者"同步组
                if (syncGroup.name === '缓冲区' || syncGroup.name === '被警告者') continue;

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
                    logTime(`[身份同步] 同步用户 ${member.user.tag} 在服务器 ${guildId} 的身份组失败: ${error.message}`, true);
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
        logTime(`[身份同步] 处理用户 ${member.user.tag} 的身份组同步时发生错误: ${error.message}`, true);
        throw error;
    }
};

/**
 * 批量处理用户的多个同步组身份组（添加或移除）
 * @param {Object} client - Discord客户端
 * @param {string} userId - 目标用户ID
 * @param {Array<Object>} syncGroups - 要处理的同步组配置数组
 * @param {string} reason - 操作原因
 * @param {boolean} isRemove - 是否为移除操作，否则为添加操作
 * @returns {Promise<{success: boolean, successfulServers: string[], failedServers: Array<{id: string, name: string}>}>}
 */
export const manageRolesByGroups = async (client, userId, syncGroups, reason, isRemove = false) => {
    const successfulServers = [];
    const failedServers = [];
    const operation = isRemove ? '移除' : '添加';

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

                    // 检查用户的身份组状态，确定需要操作的身份组
                    const rolesToProcess = Array.from(roleIds).filter(roleId =>
                        isRemove ? member.roles.cache.has(roleId) : !member.roles.cache.has(roleId)
                    );

                    if (rolesToProcess.length === 0) {
                        logTime(`[身份同步] 用户 ${member.user.tag} 在服务器 ${guild.name} 没有需要${operation}的身份组`);
                        continue;
                    }

                    // 执行角色操作
                    if (isRemove) {
                        await member.roles.remove(rolesToProcess, reason);
                    } else {
                        await member.roles.add(rolesToProcess, reason);
                    }

                    successfulServers.push(guild.name);
                    logTime(
                        `[身份同步] 已在服务器 ${guild.name} ${operation}用户 ${member.user.tag} 的 ${rolesToProcess.length} 个身份组`,
                    );

                    // 添加API请求延迟
                    await delay(500);
                } catch (error) {
                    logTime(`[身份同步] 在服务器 ${guildId} ${operation}身份组失败: ${error.message}`, true);
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
        logTime(`[身份同步] 批量${operation}身份组操作失败: ${error.message}`, true);
        return {
            success: false,
            successfulServers,
            failedServers,
        };
    }
};

/**
 * 设置辩诉参与者身份组（添加辩诉通行权限并移除已验证身份组）
 * @param {Object} client - Discord客户端
 * @param {Object} guildConfig - 服务器配置
 * @param {string} executorId - 执行者ID
 * @param {string} targetId - 目标用户ID
 * @param {string} reason - 操作原因
 * @returns {Promise<void>}
 */
export const setupDebateParticipantRoles = async (client, guildConfig, executorId, targetId, reason) => {
    try {
        const mainGuild = await client.guilds.fetch(guildConfig.id).catch(() => null);
        if (!mainGuild || !guildConfig.roleApplication?.appealDebateRoleId) {
            return;
        }

        // 1. 获取双方成员对象
        const [executorMember, targetMember] = await Promise.all([
            mainGuild.members.fetch(executorId).catch(() => null),
            mainGuild.members.fetch(targetId).catch(() => null),
        ]);

        // 2. 为双方添加辩诉通行身份组
        const addRolePromises = [executorMember, targetMember]
            .filter(member => member) // 过滤掉不存在的成员
            .map(member =>
                member.roles
                    .add(guildConfig.roleApplication?.appealDebateRoleId, reason)
                    .then(() => logTime(`[身份同步] 已添加用户 ${member.user.tag} 的辩诉通行身份组`))
                    .catch(error => logTime(`[身份同步] 添加辩诉通行身份组失败 (${member.user.tag}): ${error.message}`, true)),
            );

        await Promise.all(addRolePromises);

        // 3. 获取已验证身份组的同步组
        const roleSyncConfig = getRoleSyncConfig();
        const verifiedGroup = roleSyncConfig.syncGroups.find(group => group.name === '已验证');

        if (verifiedGroup) {
            // 4. 移除目标用户的已验证身份组
            await manageRolesByGroups(
                client,
                targetId,
                [verifiedGroup],
                `${reason}期间暂时移除已验证身份组`,
                true // 移除操作
            );
        }
    } catch (error) {
        logTime(`[身份同步] 设置辩诉参与者身份组失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 处理投票结束后的辩诉相关身份组管理
 * @param {Object} client - Discord客户端
 * @param {string} executorId - 执行者ID
 * @param {string} targetId - 目标用户ID
 * @returns {Promise<void>}
 */
export const handleDebateRolesAfterVote = async (client, executorId, targetId) => {
    try {
        // 获取主服务器配置
        const mainGuildConfig = Array.from(client.guildManager.guilds.values()).find(
            config => config.serverType === 'Main server',
        );

        if (!mainGuildConfig?.courtSystem?.enabled) {
            return;
        }

        const mainGuild = await client.guilds.fetch(mainGuildConfig.id).catch(() => null);
        if (!mainGuild) {
            return;
        }

        // 获取双方成员对象
        const [executorMember, targetMember] = await Promise.all([
            mainGuild.members.fetch(executorId).catch(() => null),
            mainGuild.members.fetch(targetId).catch(() => null),
        ]);

        // 1. 移除辩诉通行身份组
        if (mainGuildConfig.roleApplication?.appealDebateRoleId) {
            // 为双方移除辩诉通行身份组
            const removeRolePromises = [executorMember, targetMember]
                .filter(member => member) // 过滤掉不存在的成员
                .map(member =>
                    member.roles
                        .remove(mainGuildConfig.roleApplication?.appealDebateRoleId, '投票结束，移除辩诉通行身份组')
                        .then(() => logTime(`[身份同步] 已移除用户 ${member.user.tag} 的辩诉通行身份组`))
                        .catch(error =>
                            logTime(
                                `[身份同步] 移除辩诉通行身份组失败 (${member.user.tag}): ${error.message}`,
                                true,
                            ),
                        ),
                );

            await Promise.all(removeRolePromises);
        }

        // 2. 恢复已验证身份组
        try {
            // 获取已验证身份组的同步组
            const roleSyncConfig = getRoleSyncConfig();
            const verifiedGroup = roleSyncConfig.syncGroups.find(group => group.name === '已验证');

            if (verifiedGroup && targetMember) {
                // 为目标用户恢复已验证身份组
                await manageRolesByGroups(
                    client,
                    targetId,
                    [verifiedGroup],
                    '投票结束，恢复已验证身份组',
                    false // 添加操作
                );
                logTime(`[身份同步] 已为用户 ${targetId} 恢复已验证身份组`);
            }
        } catch (error) {
            logTime(`[身份同步] 恢复已验证身份组失败: ${error.message}`, true);
        }
    } catch (error) {
        logTime(`[身份同步] 处理投票后身份组管理失败: ${error.message}`, true);
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

        // 获取身份组同步配置
        const roleSyncConfig = getRoleSyncConfig();

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

                const result = await manageRolesByGroups(
                    interaction.client,
                    interaction.user.id,
                    [senatorSyncGroup],
                    '用户自行退出',
                    true // 移除操作
                );

                // 根据结果决定显示的消息
                if (result.success) {
                    logTime(
                        `[身份同步] 用户 ${interaction.user.tag} 成功退出了赛博议员身份组，已在 ${result.successfulServers.length} 个服务器移除权限`,
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
                    logTime(`[身份同步] 用户 ${interaction.user.tag} 尝试退出赛博议员身份组失败`, true);

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
        logTime(`[身份同步] 处理用户退出赛博议员身份组时发生错误: ${error.message}`, true);
        await handleInteractionError(interaction, error);
    }
}

/**
 * 验证志愿者申请条件
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {Object} guildConfig - 服务器配置
 * @returns {Promise<{isValid: boolean, reason?: string}>}
 */
export async function validateVolunteerApplication(member, guildConfig) {
    try {
        // 1. 检查加入时间（至少一个月）
        const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        if (member.joinedTimestamp > oneMonthAgo) {
            return {
                isValid: false,
                reason: '您需要加入社区满一个月才能申请志愿者身份组',
            };
        }

        // 2. 检查是否被警告
        if (guildConfig.roleApplication?.WarnedRoleId && member.roles.cache.has(guildConfig.roleApplication.WarnedRoleId)) {
            return {
                isValid: false,
                reason: '您目前处于被警告状态，无法申请志愿者身份组',
            };
        }

        // 3. 检查是否为创作者（推荐条件）
        const hasCreatorRole = guildConfig.roleApplication?.creatorRoleId &&
                              member.roles.cache.has(guildConfig.roleApplication.creatorRoleId);

        if (hasCreatorRole) {
            return {
                isValid: true,
            };
        }

        // 4. 检查是否有有效的投稿记录
        const hasValidSubmission = hasValidSubmissionRecord(member.user.id);

        if (hasValidSubmission) {
            return {
                isValid: true,
            };
        }

        return {
            isValid: false,
            reason: '获得志愿者身份组需要满足以下条件之一：1) 拥有创作者身份组 2) 在意见信箱中提出过被审定为合理的建议',
        };
    } catch (error) {
        logTime(`[身份同步] 验证志愿者申请条件时发生错误: ${error.message}`, true);
        return {
            isValid: false,
            reason: '验证申请条件时出错，请稍后重试',
        };
    }
}

/**
 * 处理志愿者身份组申请
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function applyVolunteerRole(interaction) {
    try {
        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

        // 获取志愿者身份组的同步配置
        const roleSyncConfig = getRoleSyncConfig();
        const volunteerSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '社区志愿者');

        if (!volunteerSyncGroup) {
            await interaction.editReply({
                content: '❌ 无法找到志愿者身份组同步配置',
            });
            return;
        }

        // 使用身份组同步系统添加志愿者身份组
        const result = await manageRolesByGroups(
            interaction.client,
            interaction.user.id,
            [volunteerSyncGroup],
            '用户自行申请志愿者身份组',
            false // 添加操作
        );

        // 根据结果决定显示的消息
        if (result.success) {
            logTime(
                `[身份同步] 用户 ${interaction.user.tag} 成功申请了志愿者身份组`,
            );

            await interaction.editReply({
                content: [
                    '✅ 志愿者身份组申请成功',
                    '',
                    `已在以下服务器获得志愿者身份组：`,
                    result.successfulServers.join('\n'),
                    '',
                    '感谢您成为社区志愿者！',
                ].join('\n'),
            });
        } else {
            logTime(`[身份同步] 用户 ${interaction.user.tag} 申请志愿者身份组失败`, true);

            await interaction.editReply({
                content: '❌ 申请志愿者身份组失败，请联系管理员',
            });
        }
    } catch (error) {
        logTime(`[身份同步] 处理志愿者身份组申请时发生错误: ${error.message}`, true);
        await handleInteractionError(interaction, error);
    }
}

/**
 * 处理用户退出志愿者身份组的请求
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function exitVolunteerRole(interaction) {
    try {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('volunteer_exit', interaction.user.id, 60000); // 1分钟冷却
        if (cooldownLeft) {
            await interaction.editReply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次操作`,
            });
            return;
        }

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig || !guildConfig.roleApplication || !guildConfig.roleApplication.volunteerRoleId) {
            await interaction.editReply({
                content: '❌ 服务器未正确配置志愿者身份组',
            });
            return;
        }

        // 检查用户是否有志愿者身份组
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(guildConfig.roleApplication.volunteerRoleId)) {
            await interaction.editReply({
                content: '❌ 您没有志愿者身份组，无需退出',
            });
            return;
        }

        // 获取身份组同步配置
        const roleSyncConfig = getRoleSyncConfig();

        // 查找志愿者同步组
        const volunteerSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '社区志愿者');

        if (!volunteerSyncGroup) {
            await interaction.editReply({
                content: '❌ 无法找到志愿者身份组同步配置',
            });
            return;
        }

        // 创建确认按钮
        const confirmEmbed = {
            title: '⚠️ 确认退出志愿者身份组',
            description: ['您确定要退出社区服务器的志愿者身份组吗？'].join('\n'),
            color: 0xff0000,
        };

        // 显示确认按钮
        await handleConfirmationButton({
            interaction,
            embed: confirmEmbed,
            customId: `confirm_exit_volunteer_${interaction.user.id}`,
            buttonLabel: '确认退出',
            onConfirm: async confirmation => {
                await confirmation.deferUpdate();

                const result = await manageRolesByGroups(
                    interaction.client,
                    interaction.user.id,
                    [volunteerSyncGroup],
                    '用户自行退出',
                    true // 移除操作
                );

                // 根据结果决定显示的消息
                if (result.success) {
                    logTime(
                        `[身份同步] 用户 ${interaction.user.tag} 成功退出了志愿者身份组`,
                    );

                    await confirmation.editReply({
                        embeds: [
                            {
                                title: '✅ 已退出志愿者身份组',
                                description: `成功在以下服务器移除志愿者身份组：\n${result.successfulServers.join('\n')}`,
                                color: 0x00ff00,
                            },
                        ],
                        components: [],
                    });
                } else {
                    logTime(`[身份同步] 用户 ${interaction.user.tag} 尝试退出志愿者身份组失败`, true);

                    await confirmation.editReply({
                        embeds: [
                            {
                                title: '❌ 退出志愿者身份组失败',
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
                            description: '您取消了退出志愿者身份组的操作',
                            color: 0x808080,
                        },
                    ],
                    components: [],
                });
            },
        });
    } catch (error) {
        logTime(`[身份同步] 处理用户退出志愿者身份组时发生错误: ${error.message}`, true);
        await handleInteractionError(interaction, error);
    }
}

/**
 * 读取意见记录配置
 * @returns {Object} 意见记录配置对象
 */
export const getOpinionRecords = () => {
    try {
        return JSON.parse(readFileSync(opinionRecordsPath, 'utf8'));
    } catch (error) {
        logTime(`[意见记录] 读取意见记录配置失败: ${error.message}`, true);
        // 如果文件不存在，返回默认结构
        return {
            validSubmissions: []
        };
    }
};

/**
 * 写入意见记录配置
 * @param {Object} records - 意见记录对象
 */
export const saveOpinionRecords = (records) => {
    try {
        writeFileSync(opinionRecordsPath, JSON.stringify(records, null, 4), 'utf8');
    } catch (error) {
        logTime(`[意见记录] 保存意见记录配置失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 更新意见记录
 * @param {string} userId - 用户ID
 * @param {string} submissionType - 投稿类型 (news/opinion)
 * @param {boolean} isApproved - 是否被批准
 * @param {Object} [submissionData] - 投稿数据 {title: string, content: string}
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function updateOpinionRecord(userId, submissionType, isApproved, submissionData = null) {
    try {
        if (!isApproved) {
            // 如果是拒绝，不需要记录到文件中
            return {
                success: true,
                message: '投稿已标记为不合理'
            };
        }

        // 读取现有记录
        const records = getOpinionRecords();

        // 检查用户是否已有记录
        const existingUserRecord = records.validSubmissions.find(record => record.userId === userId);

        const submissionRecord = {
            type: submissionType,
            title: submissionData?.title || '未记录标题',
            content: submissionData?.content || '未记录内容',
            approvedAt: new Date().toISOString()
        };

        if (existingUserRecord) {
            // 更新现有用户记录
            existingUserRecord.submissions.push(submissionRecord);
        } else {
            // 创建新用户记录
            records.validSubmissions.push({
                userId: userId,
                submissions: [submissionRecord]
            });
        }

        // 保存记录
        saveOpinionRecords(records);

        logTime(`[意见记录] 已记录用户 ${userId} 的有效${submissionType === 'news' ? '新闻投稿' : '社区意见'}: "${submissionRecord.title}"`);

        return {
            success: true,
            message: '投稿已标记为合理并记录'
        };
    } catch (error) {
        logTime(`[意见记录] 更新意见记录失败: ${error.message}`, true);
        return {
            success: false,
            message: '更新记录时出错'
        };
    }
}

/**
 * 检查用户是否有有效的投稿记录
 * @param {string} userId - 用户ID
 * @returns {boolean} 是否有有效记录
 */
export function hasValidSubmissionRecord(userId) {
    try {
        const records = getOpinionRecords();
        const userRecord = records.validSubmissions.find(record => record.userId === userId);
        return userRecord && userRecord.submissions.length > 0;
    } catch (error) {
        logTime(`[意见记录] 检查投稿记录失败: ${error.message}`, true);
        return false;
    }
}
