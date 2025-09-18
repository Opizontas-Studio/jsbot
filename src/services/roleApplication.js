import { ChannelType } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { EmbedFactory } from '../factories/embedFactory.js';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';
import { BlacklistService } from './blacklistService.js';
import { opinionMailboxService } from './opinionMailboxService.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

/**
 * 读取身份组同步配置
 * @returns {Object} 身份组同步配置对象
 */
export const getRoleSyncConfig = () => {
    return ErrorHandler.handleServiceSync(
        () => JSON.parse(readFileSync(roleSyncConfigPath, 'utf8')),
        "读取身份组同步配置",
        { throwOnError: true }
    );
};

/**
 * 同步用户的身份组
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {boolean} [isAutoSync=false] - 是否为自动同步（加入服务器时）
 * @returns {Promise<{syncedRoles: Array<{name: string, sourceServer: string, targetServer: string}>}>}
 */
export const syncMemberRoles = async (member, isAutoSync = false) => {
    return await ErrorHandler.handleService(
        async () => {
            // 读取身份组同步配置
            const roleSyncConfig = ErrorHandler.handleSilent(
                () => getRoleSyncConfig(),
                "读取身份组同步配置",
                { syncGroups: [] }
            );
            const syncedRoles = [];
            const guildRolesMap = new Map(); // Map<guildId, Set<roleId>>
            const guildSyncGroups = new Map(); // Map<guildId, Map<roleId, {name, sourceServer}>>

            await globalRequestQueue.add(async () => {
                // 获取所有服务器的成员信息
                const memberCache = new Map();
                for (const guild of member.client.guilds.cache.values()) {
                    // 使用静默错误处理获取成员信息
                    const guildMember = await ErrorHandler.handleSilent(
                        async () => await guild.members.fetch(member.user.id),
                        `获取用户 ${member.user.tag} 在服务器 ${guild.name} 的成员信息`
                    );

                    if (guildMember) {
                        memberCache.set(guild.id, guildMember);
                        guildRolesMap.set(guild.id, new Set());
                        guildSyncGroups.set(guild.id, new Map());
                    }
                }

                // 遍历每个同步组
                const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
                for (const syncGroup of syncGroups) {
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

                    // 使用静默错误处理进行身份组同步
                    await ErrorHandler.handleSilent(
                        async () => {
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
                        },
                        `同步用户 ${member.user.tag} 在服务器 ${guildId} 的身份组`
                    );
                }
            }, 2);

            // 记录日志
            if (syncedRoles.length > 0) {
                const syncSummary = syncedRoles
                    .map(role => `${role.name}(${role.sourceServer}=>${role.targetServer})`)
                    .join('、');
                logTime(`${isAutoSync ? '[自动同步] ' : '[手动同步] '}用户 ${member.user.tag} 同步结果：${syncSummary}`);
            }

            return { syncedRoles };
        },
        `处理用户 ${member.user.tag} 的身份组同步`,
        { throwOnError: true }
    );
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
    await ErrorHandler.handleService(
        async () => {
            const mainGuild = await client.guilds.fetch(guildConfig.id);
            if (!guildConfig.roleApplication?.appealDebateRoleId) {
                return; // 未配置辩诉身份组，直接返回
            }

            // 1. 获取双方成员对象
            const [executorMember, targetMember] = await Promise.all([
                ErrorHandler.handleSilent(
                    () => mainGuild.members.fetch(executorId),
                    `获取执行者 ${executorId} 的成员信息`
                ),
                ErrorHandler.handleSilent(
                    () => mainGuild.members.fetch(targetId),
                    `获取目标用户 ${targetId} 的成员信息`
                )
            ]);

            // 2. 为双方添加辩诉通行身份组
            const validMembers = [executorMember, targetMember].filter(member => member);
            const addRolePromises = validMembers.map(member =>
                ErrorHandler.handleSilent(
                    async () => {
                        await member.roles.add(guildConfig.roleApplication.appealDebateRoleId, reason);
                        logTime(`[身份同步] 已添加用户 ${member.user.tag} 的辩诉通行身份组`);
                    },
                    `添加用户 ${member.user.tag} 的辩诉通行身份组`
                )
            );

            await Promise.all(addRolePromises);

            // 3. 获取已验证身份组的同步组
            const roleSyncConfig = ErrorHandler.handleSilent(
                () => getRoleSyncConfig(),
                "读取身份组同步配置",
                { syncGroups: [] }
            );
            const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
            const verifiedGroup = syncGroups.find(group => group.name === '已验证');

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
        },
        "设置辩诉参与者身份组",
        { throwOnError: true }
    );
};

/**
 * 处理投票结束后的辩诉相关身份组管理
 * @param {Object} client - Discord客户端
 * @param {string} executorId - 执行者ID
 * @param {string} targetId - 目标用户ID
 * @returns {Promise<void>}
 */
export const handleDebateRolesAfterVote = async (client, executorId, targetId) => {
    await ErrorHandler.handleSilent(
        async () => {
            // 获取主服务器配置
            const mainGuildConfig = client.guildManager.getMainServerConfig();

            if (!mainGuildConfig?.courtSystem?.enabled) {
                return;
            }

            const mainGuild = await client.guilds.fetch(mainGuildConfig.id);

            // 获取双方成员对象
            const [executorMember, targetMember] = await Promise.all([
                ErrorHandler.handleSilent(
                    () => mainGuild.members.fetch(executorId),
                    `获取执行者 ${executorId} 的成员信息`
                ),
                ErrorHandler.handleSilent(
                    () => mainGuild.members.fetch(targetId),
                    `获取目标用户 ${targetId} 的成员信息`
                )
            ]);

            // 1. 移除辩诉通行身份组
            if (mainGuildConfig.roleApplication?.appealDebateRoleId) {
                // 为双方移除辩诉通行身份组
                const validMembers = [executorMember, targetMember].filter(member => member);
                const removeRolePromises = validMembers.map(member =>
                    ErrorHandler.handleSilent(
                        async () => {
                            await member.roles.remove(
                                mainGuildConfig.roleApplication.appealDebateRoleId,
                                '投票结束，移除辩诉通行身份组'
                            );
                            logTime(`[身份同步] 已移除用户 ${member.user.tag} 的辩诉通行身份组`);
                        },
                        `移除用户 ${member.user.tag} 的辩诉通行身份组`
                    )
                );

                await Promise.all(removeRolePromises);
            }

            // 2. 恢复已验证身份组
            await ErrorHandler.handleSilent(
                async () => {
                    // 获取已验证身份组的同步组
                    const roleSyncConfig = ErrorHandler.handleSilent(
                        () => getRoleSyncConfig(),
                        "读取身份组同步配置",
                        { syncGroups: [] }
                    );
                    const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
                    const verifiedGroup = syncGroups.find(group => group.name === '已验证');

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
                },
                "恢复已验证身份组"
            );
        },
        "处理投票后身份组管理"
    );
};

/**
 * 验证志愿者申请条件
 * @param {GuildMember} member - Discord服务器成员对象
 * @param {Object} guildConfig - 服务器配置
 * @returns {Promise<{isValid: boolean, reason?: string}>}
 */
export async function validateVolunteerApplication(member, guildConfig) {
    const result = await ErrorHandler.handleService(
        async () => {
            // 1. 检查是否受到过处罚
            if (BlacklistService.isUserBlacklisted(member.user.id)) {
                return {
                    isValid: false,
                    reason: '您没有资格申请志愿者身份组',
                };
            }

            // 2. 检查加入时间（至少一个月）
            const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
            if (member.joinedTimestamp > oneMonthAgo) {
                return {
                    isValid: false,
                    reason: '您需要加入社区满一个月才能申请志愿者身份组',
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
            const hasValidSubmission = opinionMailboxService.hasValidSubmissionRecord(member.user.id);

            if (hasValidSubmission) {
                return {
                    isValid: true,
                };
            }

            return {
                isValid: false,
                reason: '获得志愿者身份组需要满足以下条件之一：1) 拥有创作者身份组 2) 在意见信箱中提出过被审定为合理的建议',
            };
        },
        "验证志愿者申请条件"
    );

    // 如果验证失败，返回错误信息
    if (!result.success) {
        return {
            isValid: false,
            reason: '验证申请条件时出错，请稍后重试',
        };
    }

    return result.data;
}

/**
 * 处理志愿者身份组申请
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function applyVolunteerRole(interaction) {
    await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 获取志愿者身份组的同步配置
            const roleSyncConfig = ErrorHandler.handleSilent(
                () => getRoleSyncConfig(),
                "读取身份组同步配置",
                { syncGroups: [] }
            );
            const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
            const volunteerSyncGroup = syncGroups.find(group => group.name === '社区志愿者');

            if (!volunteerSyncGroup) {
                throw new Error('无法找到志愿者身份组同步配置');
            }

            // 使用身份组同步系统添加志愿者身份组
            const result = await manageRolesByGroups(
                interaction.client,
                interaction.user.id,
                [volunteerSyncGroup],
                '用户自行申请志愿者身份组',
                false // 添加操作
            );

            if (!result.success) {
                throw new Error('申请志愿者身份组失败，请联系管理员');
            }

            logTime(`[身份同步] 用户 ${interaction.user.tag} 成功申请了志愿者身份组`);

            // 使用EmbedFactory创建成功消息
            const successEmbed = EmbedFactory.createVolunteerApplicationSuccessEmbed(result.successfulServers);

            await interaction.editReply({
                embeds: [successEmbed]
            });

            return result;
        },
        "处理志愿者身份组申请",
        { ephemeral: true }
    );
}

/**
 * 处理用户退出志愿者身份组的请求
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function exitVolunteerRole(interaction) {
    await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 获取服务器配置
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
            if (!guildConfig.roleApplication?.volunteerRoleId) {
                throw new Error('服务器未配置志愿者身份组功能');
            }

            // 检查用户是否有志愿者身份组
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!member.roles.cache.has(guildConfig.roleApplication.volunteerRoleId)) {
                throw new Error('您没有志愿者身份组，无需退出');
            }

            // 获取身份组同步配置
            const roleSyncConfig = ErrorHandler.handleSilent(
                () => getRoleSyncConfig(),
                "读取身份组同步配置",
                { syncGroups: [] }
            );

            // 查找志愿者同步组
            const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
            const volunteerSyncGroup = syncGroups.find(group => group.name === '社区志愿者');

            if (!volunteerSyncGroup) {
                throw new Error('无法找到志愿者身份组同步配置');
            }

            // 使用EmbedFactory创建确认embed
            const confirmEmbed = EmbedFactory.createVolunteerExitConfirmEmbed();

            // 显示确认按钮
            await handleConfirmationButton({
                interaction,
                embed: confirmEmbed,
                customId: `confirm_exit_volunteer_${interaction.user.id}`,
                buttonLabel: '确认退出',
                onConfirm: async confirmation => {
                    await confirmation.deferUpdate();

                    // 使用ErrorHandler处理退出操作
                    const result = await ErrorHandler.handleService(
                        async () => {
                            const exitResult = await manageRolesByGroups(
                                interaction.client,
                                interaction.user.id,
                                [volunteerSyncGroup],
                                '用户自行退出',
                                true // 移除操作
                            );

                            if (!exitResult.success) {
                                throw new Error('退出志愿者身份组失败');
                            }

                            return exitResult;
                        },
                        "退出志愿者身份组"
                    );

                    let resultEmbed;
                    if (result.success) {
                        logTime(`[身份同步] 用户 ${interaction.user.tag} 成功退出了志愿者身份组`);
                        resultEmbed = EmbedFactory.createVolunteerExitResultEmbed(true, result.data.successfulServers);
                    } else {
                        logTime(`[身份同步] 用户 ${interaction.user.tag} 尝试退出志愿者身份组失败`, true);
                        resultEmbed = EmbedFactory.createVolunteerExitResultEmbed(false, [], result.error);
                    }

                    await confirmation.editReply({
                        embeds: [resultEmbed],
                        components: [],
                    });
                },
                onTimeout: async () => {
                    const cancelledEmbed = EmbedFactory.createVolunteerExitCancelledEmbed();
                    await interaction.editReply({
                        embeds: [cancelledEmbed],
                        components: [],
                    });
                },
            });
        },
        "处理用户退出志愿者身份组",
        { ephemeral: true }
    );
}

/**
 * 处理创作者身份组申请的业务逻辑
 * @param {Object} client - Discord客户端
 * @param {Object} interaction - Discord交互对象
 * @param {string} threadLink - 帖子链接
 * @returns {Promise<Object>} 处理结果
 */
export async function handleCreatorRoleApplication(client, interaction, threadLink) {
    return await ErrorHandler.handleService(
        async () => {
            const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);
            if (!matches) {
                throw new Error('无效的帖子链接格式');
            }

            const [, linkGuildId, threadId] = matches;
            const currentGuildConfig = client.guildManager.getGuildConfig(interaction.guildId);

            // 检查链接所属服务器是否在配置中
            const linkGuildConfig = client.guildManager.getGuildConfig(linkGuildId);
            if (!linkGuildConfig) {
                throw new Error('提供的帖子不在允许的服务器中');
            }

            // 使用队列处理申请逻辑
            const result = await globalRequestQueue.add(async () => {
                const thread = await client.channels.fetch(threadId);

                if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
                    throw new Error('提供的链接不是论坛帖子');
                }

                // 获取首条消息
                const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
                const threadStarter = firstMessage.first();

                if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
                    throw new Error('您不是该帖子的作者');
                }

                // 获取反应数最多的表情
                let maxReactions = 0;
                threadStarter.reactions.cache.forEach(reaction => {
                    const count = reaction.count;
                    if (count > maxReactions) {
                        maxReactions = count;
                    }
                });

                // 使用EmbedFactory创建审核日志
                const auditEmbed = EmbedFactory.createCreatorRoleAuditEmbed({
                    user: interaction.user,
                    threadLink,
                    maxReactions,
                    serverName: thread.guild.name,
                    approved: maxReactions >= 5
                });

                if (maxReactions >= 5) {
                    // 读取身份组同步配置（可容错操作）
                    const roleSyncConfig = ErrorHandler.handleSilent(
                        () => getRoleSyncConfig(),
                        "加载身份组同步配置",
                        { syncGroups: [] }
                    );

                    // 确保syncGroups存在且为数组
                    const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
                    const creatorSyncGroup = syncGroups.find(group => group.name === '创作者');

                    let successMessage = '';
                    if (creatorSyncGroup) {
                        // 使用manageRolesByGroups函数批量添加身份组
                        const roleResult = await manageRolesByGroups(
                            client,
                            interaction.user.id,
                            [creatorSyncGroup],
                            '创作者身份组申请通过',
                            false // 设置为添加操作
                        );

                        // 检查是否有成功的服务器
                        if (roleResult.successfulServers.length > 0) {
                            successMessage = `审核通过！已为您添加创作者身份组${
                                roleResult.successfulServers.length > 1
                                    ? `（已同步至：${roleResult.successfulServers.join('、')}）`
                                    : ''
                            }`;

                            logTime(
                                `[自动审核] 用户 ${interaction.user.tag} 获得了创作者身份组, 同步至: ${roleResult.successfulServers.join('、')}`
                            );
                        } else {
                            throw new Error('添加身份组时出现错误，请联系管理员');
                        }
                    } else {
                        // 如果没有找到同步配置，只在当前服务器添加
                        const member = await interaction.guild.members.fetch(interaction.user.id);
                        await member.roles.add(currentGuildConfig.roleApplication.creatorRoleId);
                        successMessage = '审核通过，已为您添加创作者身份组。';
                    }

                    // 发送审核日志（可容错操作）
                    await ErrorHandler.handleSilent(
                        async () => {
                            const moderationChannel = await client.channels.fetch(
                                currentGuildConfig.roleApplication.logThreadId
                            );
                            if (moderationChannel) {
                                await moderationChannel.send({ embeds: [auditEmbed] });
                            }
                        },
                        "发送审核日志"
                    );

                    return { success: true, message: successMessage };
                } else {
                    return { success: false, message: '审核未通过，请获取足够正面反应后再申请。' };
                }
            }, 3); // 用户指令优先级

            return result;
        },
        "处理创作者身份组申请"
    );
}
