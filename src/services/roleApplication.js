import { DiscordAPIError } from '@discordjs/rest';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleDiscordError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const messageIdsPath = join(process.cwd(), 'data', 'messageIds.json');

/**
 * 处理创建申请消息
 * @param {Client} client - Discord客户端
 */
export const createApplicationMessage = async (client) => {
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
	                logTime(`删除旧申请消息失败: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error}`, true);
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
	            if (!channel) return;

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
	                .setDescription('请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您添加创作者身份组。')
	                .setColor(0x0099FF);

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
	        logTime(`在服务器 ${guildId} 创建身份组申请消息时出错: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error}`, true);
	    }
    }
};