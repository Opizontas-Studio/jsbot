import { DiscordAPIError } from '@discordjs/rest';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { delay, globalRequestQueue } from '../utils/concurrency.js';
import { handleDiscordError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const messageIdsPath = join(process.cwd(), 'data', 'messageIds.json');
const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

/**
 * 处理创建申请消息
 * @param {Client} client - Discord客户端
 */
export const createApplicationMessage = async client => {
    // 读取消息ID配置
    let messageIds;
    try {
        messageIds = JSON.parse(readFileSync(messageIdsPath, 'utf8'));
        if (!messageIds.roleApplicationMessages) {
            messageIds.roleApplicationMessages = {};
        }
    } catch (error) {
        logTime(`读取消息ID配置失败: ${error}`, true);
        return;
    }

    // 为每个配置了身份组申请功能的服务器检查/创建申请消息
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        // 检查功能是否启用
        if (!guildConfig?.roleApplication?.enabled) {
            // 如果功能被禁用，删除旧的申请消息（如果存在）
            const oldMessageId = messageIds.roleApplicationMessages[guildId];
            if (oldMessageId && guildConfig?.roleApplication?.creatorRoleThreadId) {
                try {
                    await globalRequestQueue.add(async () => {
                        const channel = await client.channels.fetch(guildConfig.roleApplication.creatorRoleThreadId);
                        if (channel) {
                            const oldMessage = await channel.messages.fetch(oldMessageId);
                            if (oldMessage) {
                                await oldMessage.delete();
                                logTime(`已删除服务器 ${guildId} 的旧申请消息（功能已禁用）`);
                            }
                        }
                    }, 3); // 用户指令优先级
                    // 清除消息ID记录
                    delete messageIds.roleApplicationMessages[guildId];
                    writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
                } catch (error) {
                    logTime(
                        `删除旧申请消息失败: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error}`,
                        true,
                    );
                }
            } else if (oldMessageId) {
                // 如果有旧消息ID但没有配置，直接删除记录
                delete messageIds.roleApplicationMessages[guildId];
                writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
                logTime(`清理服务器 ${guildId} 的旧申请消息记录（配置不完整）`);
            }
            continue;
        }

        // 检查必要的配置是否存在
        if (!guildConfig.roleApplication?.creatorRoleThreadId || !guildConfig.roleApplication?.creatorRoleId) {
            logTime(`服务器 ${guildId} 的身份组申请配置不完整`, true);
            continue;
        }

        try {
            await globalRequestQueue.add(async () => {
                const channel = await client.channels.fetch(guildConfig.roleApplication.creatorRoleThreadId);
                if (!channel) {
                    return;
                }

                // 检查是否已存在消息
                const existingMessageId = messageIds.roleApplicationMessages[guildId];
                if (existingMessageId) {
                    try {
                        await channel.messages.fetch(existingMessageId);
                        logTime(`服务器 ${guildId} 的申请消息已存在，无需重新创建`);
                        return;
                    } catch (error) {
                        logTime(`服务器 ${guildId} 的现有申请消息已失效: ${error.message}`, true);
                    }
                }

                // 创建申请按钮
                const button = new ButtonBuilder()
                    .setCustomId('apply_creator_role')
                    .setLabel('申请')
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(button);

                // 创建嵌入消息
                const embed = new EmbedBuilder()
                    .setTitle('创作者身份组自助申请')
                    .setDescription(
                        '请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您在所有服务器添加创作者身份组。',
                    )
                    .setColor(0x0099ff);

                // 发送新消息并保存消息ID
                const newMessage = await channel.send({
                    embeds: [embed],
                    components: [row],
                });

                messageIds.roleApplicationMessages[guildId] = newMessage.id;
                writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));

                logTime(`已在服务器 ${guildId} 创建新的身份组申请消息`);
            }, 3); // 用户指令优先级
        } catch (error) {
            logTime(
                `在服务器 ${guildId} 创建身份组申请消息时出错: ${
                    error instanceof DiscordAPIError ? handleDiscordError(error) : error
                }`,
                true,
            );
        }
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
 * 处理创建身份组同步消息
 * @param {Client} client - Discord客户端
 */
export const createSyncMessage = async client => {
    // 读取消息ID配置
    let messageIds;
    try {
        messageIds = JSON.parse(readFileSync(messageIdsPath, 'utf8'));
        if (!messageIds.roleSyncMessages) {
            messageIds.roleSyncMessages = {};
        }
    } catch (error) {
        logTime(`读取消息ID配置失败: ${error}`, true);
        return;
    }

    // 为每个服务器检查/创建同步消息
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        // 检查必要的配置是否存在
        if (!guildConfig.roleApplication?.roleSyncThreadId) {
            logTime(`服务器 ${guildId} 的身份组同步配置不完整`, true);
            continue;
        }

        try {
            await globalRequestQueue.add(async () => {
                const channel = await client.channels.fetch(guildConfig.roleApplication.roleSyncThreadId);
                if (!channel) {
                    return;
                }

                // 检查是否已存在消息
                const existingMessageId = messageIds.roleSyncMessages[guildId];
                if (existingMessageId) {
                    try {
                        await channel.messages.fetch(existingMessageId);
                        logTime(`服务器 ${guildId} 的同步消息已存在，无需重新创建`);
                        return;
                    } catch (error) {
                        logTime(`服务器 ${guildId} 的现有同步消息已失效: ${error.message}`, true);
                    }
                }

                // 创建同步按钮
                const button = new ButtonBuilder()
                    .setCustomId('sync_roles')
                    .setLabel('同步身份组')
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(button);

                // 创建嵌入消息
                const embed = new EmbedBuilder()
                    .setTitle('身份组手动同步')
                    .setDescription([
                        '在您加入时，系统已进行了类脑服务器间身份组的自动同步，但由于API速率限制，可能存在部分未同步。',
                        '若您发现自身身份组未同步，点击下方按钮可手动同步，而不需要经过准入答题。',
                        '**可同步的身份组：**',
                        '• 已验证 - 答题通过',
                        '• 创作者 - 创作者',
                        '• 赛博议员 - 议员',
                        '• 管理组 - 所有管理组',
                    ].join('\n'))
                    .setColor(0x0099ff);

                // 发送新消息并保存消息ID
                const newMessage = await channel.send({
                    embeds: [embed],
                    components: [row],
                });

                messageIds.roleSyncMessages[guildId] = newMessage.id;
                writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));

                logTime(`已在服务器 ${guildId} 创建新的身份组同步消息`);
            }, 3); // 用户指令优先级
        } catch (error) {
            logTime(
                `在服务器 ${guildId} 创建身份组同步消息时出错: ${
                    error instanceof DiscordAPIError ? handleDiscordError(error) : error
                }`,
                true,
            );
        }
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
    const processedGuilds = new Map(); // 用于缓存已处理的服务器信息

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

                    // 检查用户实际拥有的需要移除的身份组
                    const rolesToRemove = Array.from(roleIds).filter(roleId => 
                        member.roles.cache.has(roleId)
                    );

                    if (rolesToRemove.length === 0) {
                        logTime(`用户 ${member.user.tag} 在服务器 ${guild.name} 没有需要移除的身份组`);
                        continue;
                    }

                    // 一次性移除多个身份组
                    await member.roles.remove(rolesToRemove, reason);
                    successfulServers.push(guild.name);
                    logTime(`已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的 ${rolesToRemove.length} 个身份组`);

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
        logTime(`批量撤销身份组操作失败: ${error.message}`, true);
        return { 
            success: false, 
            successfulServers, 
            failedServers 
        };
    }
};
