import { DiscordAPIError } from '@discordjs/rest';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { globalRequestQueue } from '../utils/concurrency.js';
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
                        '请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您添加创作者身份组。',
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
 * 撤销用户的身份组
 * @param {Object} client - Discord客户端
 * @param {string} userId - 目标用户ID
 * @param {string} roleId - 要撤销的身份组ID
 * @param {string} reason - 撤销原因
 * @returns {Promise<{success: boolean, successfulServers: string[], failedServers: Array<{id: string, name: string}>}>}
 */
export const revokeRole = async (client, userId, roleId, reason) => {
    const successfulServers = [];
    const failedServers = [];

    try {
        // 遍历所有服务器
        const allGuilds = Array.from(client.guildManager.guilds.values());

        for (const guildData of allGuilds) {
            try {
                if (!guildData?.id) continue;

                const guild = await client.guilds.fetch(guildData.id);
                if (!guild) {
                    failedServers.push({ id: guildData.id, name: guildData.name || guildData.id });
                    continue;
                }

                const member = await guild.members.fetch(userId);
                if (!member) {
                    logTime(`用户 ${userId} 不在服务器 ${guild.name} 中`, true);
                    continue;
                }

                // 检查用户是否有该身份组
                if (!member.roles.cache.has(roleId)) {
                    logTime(`用户 ${member.user.tag} 在服务器 ${guild.name} 没有指定身份组，跳过`);
                    continue;
                }

                // 移除身份组
                await member.roles.remove(roleId, reason);
                successfulServers.push(guild.name);
                logTime(`已在服务器 ${guild.name} 移除用户 ${member.user.tag} 的身份组`);
            } catch (error) {
                logTime(`在服务器 ${guildData.id} 移除身份组失败: ${error.message}`, true);
                failedServers.push({ id: guildData.id, name: guildData.name || guildData.id });
            }
        }

        return { success: successfulServers.length > 0, successfulServers, failedServers };
    } catch (error) {
        logTime(`撤销身份组操作失败: ${error.message}`, true);
        return { success: false, successfulServers, failedServers };
    }
};

/**
 * 同步用户的身份组
 * @param {GuildMember} member - Discord服务器成员对象
 * @returns {Promise<void>}
 */
export const syncMemberRoles = async member => {
    try {
        // 读取身份组同步配置
        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

        // 将身份组同步任务加入队列
        await globalRequestQueue.add(async () => {
            // 获取所有配置的服务器
            const allGuilds = member.client.guilds.cache;
            const syncResults = [];

            // 遍历每个同步组
            for (const syncGroup of roleSyncConfig.syncGroups) {
                const currentGuildRoleId = syncGroup.roles[member.guild.id];
                if (!currentGuildRoleId) continue;

                // 检查其他服务器中是否有该身份组
                let shouldSync = false;
                let sourceGuildName = '';

                for (const [guildId, roleId] of Object.entries(syncGroup.roles)) {
                    if (guildId === member.guild.id) continue;

                    const guild = allGuilds.get(guildId);
                    if (!guild) continue;

                    try {
                        const guildMember = await guild.members.fetch(member.user.id);
                        if (guildMember && guildMember.roles.cache.has(roleId)) {
                            shouldSync = true;
                            sourceGuildName = guild.name;
                            break;
                        }
                    } catch (error) {
                        // 用户可能不在该服务器中，继续检查下一个
                        continue;
                    }
                }

                if (shouldSync) {
                    try {
                        // 添加身份组
                        await member.roles.add(currentGuildRoleId);
                        syncResults.push({
                            name: syncGroup.name,
                            success: true,
                            sourceGuild: sourceGuildName,
                        });
                    } catch (error) {
                        syncResults.push({
                            name: syncGroup.name,
                            success: false,
                            error: error.message,
                        });
                    }
                }
            }

            // 生成单条综合日志
            if (syncResults.length > 0) {
                const successResults = syncResults.filter(r => r.success);
                const failedResults = syncResults.filter(r => !r.success);

                const logParts = [];
                
                if (successResults.length > 0) {
                    const successGroups = successResults.map(r => `${r.name}（来自 ${r.sourceGuild}）`).join('、');
                    logParts.push(`成功同步：${successGroups}`);
                }
                
                if (failedResults.length > 0) {
                    const failedGroups = failedResults.map(r => `${r.name}（${r.error}）`).join('、');
                    logParts.push(`同步失败：${failedGroups}`);
                }

                logTime(`用户 ${member.user.tag} 的身份组同步结果：${logParts.join('；')}${failedResults.length > 0 ? '！' : ''}`);
            }
        }, 2); // 优先级2，比普通请求高
    } catch (error) {
        logTime(`处理身份组同步时发生错误: ${error.message}`, true);
        throw error; // 向上抛出错误，让调用者处理
    }
};
