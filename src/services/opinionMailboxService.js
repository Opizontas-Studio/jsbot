import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { delay } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';

const messageIdsPath = join(process.cwd(), 'data', 'messageIds.json');

/**
 * 意见信箱服务类
 */
class OpinionMailboxService {
    constructor() {
        this.messageIds = this.loadMessageIds();
    }

    /**
     * 获取主服务器ID
     * @param {Client} client - Discord客户端
     * @returns {string|null} 主服务器ID或null
     */
    getMainGuildId(client) {
        if (!client?.guildManager) {
            return null;
        }

        const guildIds = client.guildManager.getGuildIds();
        return guildIds.find(id => {
            const config = client.guildManager.getGuildConfig(id);
            return config?.serverType === 'Main server';
        }) || null;
    }

    /**
     * 加载消息ID配置
     * @returns {Object} 消息ID配置对象
     */
    loadMessageIds() {
        try {
            const data = readFileSync(messageIdsPath, 'utf8');
            const messageIds = JSON.parse(data);
            return messageIds;
        } catch (error) {
            logTime(`[意见信箱] 加载消息ID配置失败，将创建新配置: ${error.message}`, true);
            return {};
        }
    }

    /**
     * 保存消息ID配置
     * @param {Object} messageIds - 消息ID配置对象
     */
    saveMessageIds(messageIds) {
        try {
            writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2), 'utf8');
            this.messageIds = messageIds;
        } catch (error) {
            logTime(`[意见信箱] 保存消息ID配置失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 创建意见信箱消息内容
     * @returns {Object} 包含embed和components的消息对象
     */
    createMailboxMessage() {
        // 创建意见投稿按钮
        const opinionButton = new ButtonBuilder()
            .setCustomId('submit_opinion')
            .setLabel('提交社区意见')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💬');

        const row = new ActionRowBuilder().addComponents(opinionButton);

        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle('📮 社区意见信箱')
            .setDescription(
                [
                    '点击下方按钮，您可以向社区提交意见或建议：',
                    '',
                    '**提交要求：**',
                    '- 意见内容应当具体、建设性',
                    '- 可以是对社区的反馈或倡议',
                    '',
                    '管理组会查看并尽快处理您的意见',
                ].join('\n'),
            )
            .setColor(0x00aaff);

        return {
            embeds: [embed],
            components: [row],
        };
    }

    /**
     * 发送意见信箱消息到指定频道
     * @param {Channel} channel - 目标频道
     * @param {Client} client - Discord客户端
     * @returns {Promise<Message>} 发送的消息对象
     */
    async sendMailboxMessage(channel, client) {
        try {
            const messageContent = this.createMailboxMessage();
            const message = await channel.send(messageContent);

            // 更新消息ID记录
            this.updateMailboxMessageId(channel.id, message.id, client);

            return message;
        } catch (error) {
            logTime(`[意见信箱] 发送意见信箱消息失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新频道的意见信箱消息ID记录
     * @param {string} channelId - 频道ID
     * @param {string} messageId - 消息ID
     * @param {Client} client - Discord客户端（用于获取主服务器ID）
     */
    updateMailboxMessageId(channelId, messageId, client) {
        const guildId = this.getMainGuildId(client);
        if (!guildId) {
            throw new Error('无法获取主服务器ID');
        }
        try {
            // 确保服务器结构存在
            if (!this.messageIds[guildId]) {
                this.messageIds[guildId] = {};
            }
            if (!this.messageIds[guildId].opinionMailbox) {
                this.messageIds[guildId].opinionMailbox = {};
            }

            // 更新内存中的配置
            this.messageIds[guildId].opinionMailbox[channelId] = messageId;

            // 保存到文件
            this.saveMessageIds(this.messageIds);

            logTime(`[意见信箱] 已更新频道 ${channelId} 的消息ID记录: ${messageId}`);
        } catch (error) {
            logTime(`[意见信箱] 更新消息ID记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 获取频道的意见信箱消息ID
     * @param {string} channelId - 频道ID
     * @param {Client} client - Discord客户端（用于获取主服务器ID）
     * @returns {string|null} 消息ID或null
     */
    getMailboxMessageId(channelId, client) {
        const guildId = this.getMainGuildId(client);
        if (!guildId) {
            return null;
        }
        return this.messageIds[guildId]?.opinionMailbox?.[channelId] || null;
    }

    /**
     * 删除旧的意见信箱消息
     * @param {Channel} channel - 频道对象
     * @param {Client} client - Discord客户端
     * @returns {Promise<boolean>} 删除是否成功
     */
    async deleteOldMailboxMessage(channel, client) {
        try {
            const oldMessageId = this.getMailboxMessageId(channel.id, client);
            if (!oldMessageId) {
                return false;
            }

            try {
                const oldMessage = await channel.messages.fetch(oldMessageId);
                await oldMessage.delete();
                return true;
            } catch (fetchError) {
                logTime(`[意见信箱] 无法获取或删除旧消息 ${oldMessageId}: ${fetchError.message}`);
                return false;
            }
        } catch (error) {
            logTime(`[意见信箱] 删除旧意见信箱消息失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 检查频道最后一条消息是否为BOT发送
     * @param {Channel} channel - 频道对象
     * @returns {Promise<boolean>} 最后一条消息是否为BOT发送
     */
    async isLastMessageFromBot(channel) {
        try {
            const messages = await channel.messages.fetch({ limit: 1 });
            if (messages.size === 0) {
                return false;
            }

            const lastMessage = messages.first();
            return lastMessage.author.bot;
        } catch (error) {
            logTime(`[意见信箱] 检查频道最后消息失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 维护意见信箱消息 - 检查并重新发送如果需要
     * @param {Client} client - Discord客户端
     * @param {string} channelId - 频道ID
     * @returns {Promise<boolean>} 是否进行了维护操作
     */
    async maintainMailboxMessage(client, channelId) {
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logTime(`[意见信箱] 无法获取频道 ${channelId}`, true);
                return false;
            }

            // 检查最后一条消息是否为BOT发送
            const isLastFromBot = await this.isLastMessageFromBot(channel);
            if (isLastFromBot) {
                // 如果最后一条消息是BOT发送的，不需要维护
                return false;
            }

            // 如果最后一条消息不是BOT发送的，删除旧的意见信箱入口并重新发送
            await this.deleteOldMailboxMessage(channel, client);

            // 发送新的意见信箱消息
            await this.sendMailboxMessage(channel, client);

            logTime(`[意见信箱] 已完成频道 ${channel.name} 的意见信箱入口维护`);
            return true;
        } catch (error) {
            logTime(`[意见信箱] 维护意见信箱消息失败 [频道 ${channelId}]: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 获取所有有意见信箱入口消息记录的频道列表
     * @param {Client} client - Discord客户端（用于获取主服务器ID）
     * @returns {Array} 需要维护的频道ID列表
     */
    getMailboxChannels(client) {
        const guildId = this.getMainGuildId(client);
        if (!guildId) {
            return [];
        }
        return Object.keys(this.messageIds[guildId]?.opinionMailbox || {});
    }

    /**
     * 批量维护所有意见信箱消息
     * @param {Client} client - Discord客户端
     * @returns {Promise<number>} 维护的频道数量
     */
    async maintainAllMailboxMessages(client) {
        try {
            // 获取主服务器的频道列表
            const channelIds = this.getMailboxChannels(client);
            let maintainedCount = 0;

            for (const channelId of channelIds) {
                const maintained = await this.maintainMailboxMessage(client, channelId);
                if (maintained) {
                    maintainedCount++;
                }

                // 添加延迟以避免API速率限制
                await delay(1000);
            }

            return maintainedCount;
        } catch (error) {
            logTime(`[意见信箱] 批量维护意见信箱消息失败: ${error.message}`, true);
            return 0;
        }
    }
}

// 创建全局单例
export const opinionMailboxService = new OpinionMailboxService();
export default OpinionMailboxService;
