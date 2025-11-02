import { promises as fs } from 'fs';
import schedule from 'node-schedule';
import { join } from 'path';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { BaseCarouselService } from './BaseCarouselService.js';

const CONFIG_PATH = join(process.cwd(), 'data', 'carouselConfig.json');
const MESSAGE_IDS_PATH = join(process.cwd(), 'data', 'messageIds.json');

/**
 * 频道轮播服务 - 用于持续公告展示
 */
export class ChannelCarousel extends BaseCarouselService {
    constructor() {
        super();
        this.checkJobs = new Map(); // 存储检查任务
    }

    /**
     * 加载配置
     */
    async loadConfig() {
        return await ErrorHandler.handleSilent(
            async () => {
                const data = await fs.readFile(CONFIG_PATH, 'utf8');
                return JSON.parse(data);
            },
            '加载轮播配置',
            { channelCarousels: {} }
        );
    }

    /**
     * 保存配置
     */
    async saveConfig(config) {
        await ErrorHandler.handleService(
            () => fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2)),
            '保存轮播配置',
            { throwOnError: true }
        );
    }

    /**
     * 加载消息ID配置
     */
    async loadMessageIds() {
        return await ErrorHandler.handleSilent(
            async () => {
                const data = await fs.readFile(MESSAGE_IDS_PATH, 'utf8');
                return JSON.parse(data);
            },
            '加载消息ID配置',
            {}
        );
    }

    /**
     * 保存消息ID配置
     */
    async saveMessageIds(messageIds) {
        await ErrorHandler.handleService(
            () => fs.writeFile(MESSAGE_IDS_PATH, JSON.stringify(messageIds, null, 2)),
            '保存消息ID配置',
            { throwOnError: true }
        );
    }

    /**
     * 获取频道轮播配置
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     */
    async getChannelCarouselConfig(guildId, channelId) {
        const config = await this.loadConfig();
        return config.channelCarousels?.[guildId]?.[channelId] || null;
    }

    /**
     * 保存频道轮播配置
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {Object} carouselConfig - 轮播配置
     */
    async saveChannelCarouselConfig(guildId, channelId, carouselConfig) {
        const config = await this.loadConfig();
        if (!config.channelCarousels) {
            config.channelCarousels = {};
        }
        if (!config.channelCarousels[guildId]) {
            config.channelCarousels[guildId] = {};
        }
        config.channelCarousels[guildId][channelId] = carouselConfig;
        await this.saveConfig(config);
    }

    /**
     * 删除频道轮播配置
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     */
    async deleteChannelCarouselConfig(guildId, channelId) {
        const config = await this.loadConfig();
        if (config.channelCarousels?.[guildId]?.[channelId]) {
            delete config.channelCarousels[guildId][channelId];
            await this.saveConfig(config);
        }
    }

    /**
     * 启动频道轮播
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     */
    async startChannelCarousel(channel, guildId, channelId) {
        const carouselConfig = await this.getChannelCarouselConfig(guildId, channelId);
        if (!carouselConfig || !carouselConfig.items || carouselConfig.items.length === 0) {
            logTime(`[频道轮播] 频道 ${channelId} 无轮播配置或无条目`);
            return;
        }

        const key = `${guildId}-${channelId}`;

        await this.startCarousel(key, {
            channel,
            guildId,
            channelId,
            data: carouselConfig.items,
            pageSize: carouselConfig.itemsPerPage,
            updateIntervalSeconds: carouselConfig.updateInterval,
            config: carouselConfig,
        });

        // 启动检查任务（如果配置了检查周期）
        if (carouselConfig.checkInterval > 0) {
            this.startCheckJob(channel, guildId, channelId, carouselConfig);
        }
    }

    /**
     * 启动检查任务
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {Object} carouselConfig - 轮播配置
     */
    startCheckJob(channel, guildId, channelId, carouselConfig) {
        const key = `${guildId}-${channelId}`;
        const checkKey = `${key}-check`;

        // 停止现有的检查任务
        if (this.checkJobs.has(checkKey)) {
            this.checkJobs.get(checkKey).cancel();
            this.checkJobs.delete(checkKey);
        }

        // 创建检查任务
        const cronPattern = `*/${carouselConfig.checkInterval} * * * * *`;
        const job = schedule.scheduleJob(cronPattern, async () => {
            try {
                await this.checkAndRecreateMessage(channel, guildId, channelId, carouselConfig);
            } catch (error) {
                logTime(`[频道轮播] 检查任务失败 [${key}]: ${error.message}`, true);
            }
        });

        this.checkJobs.set(checkKey, job);
        logTime(`[频道轮播] 已启动检查任务 [${key}]，每 ${carouselConfig.checkInterval} 秒检查一次`);
    }

    /**
     * 检查并重新创建消息（如果需要）
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {Object} carouselConfig - 轮播配置
     */
    async checkAndRecreateMessage(channel, guildId, channelId, carouselConfig) {
        const messageIds = await this.loadMessageIds();
        const currentMessageId = messageIds[guildId]?.channelCarousel?.[channelId];

        if (!currentMessageId) {
            // 没有记录的消息ID，重新创建
            await this.recreateCarouselMessage(channel, guildId, channelId, messageIds);
            return;
        }

        // 获取最近的N条消息
        const recentMessagesLimit = carouselConfig.checkRecentMessages || 10;
        try {
            const recentMessages = await channel.messages.fetch({ limit: recentMessagesLimit });
            const isMessageRecent = recentMessages.has(currentMessageId);

            if (!isMessageRecent) {
                // 轮播消息不在最近N条消息内，重新创建
                logTime(`[频道轮播] 轮播消息不在最近 ${recentMessagesLimit} 条消息内，重新创建 [${guildId}-${channelId}]`);
                await this.recreateCarouselMessage(channel, guildId, channelId, messageIds);
            }
        } catch (error) {
            logTime(`[频道轮播] 检查消息失败: ${error.message}`, true);
        }
    }

    /**
     * 重新创建轮播消息
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {Object} messageIds - 消息ID配置
     */
    async recreateCarouselMessage(channel, guildId, channelId, messageIds) {
        // 删除旧消息（如果存在）
        const oldMessageId = messageIds[guildId]?.channelCarousel?.[channelId];
        if (oldMessageId) {
            try {
                const oldMessage = await channel.messages.fetch(oldMessageId);
                await oldMessage.delete();
            } catch (error) {
                // 忽略删除失败的错误
            }
        }

        // 创建新消息
        const key = `${guildId}-${channelId}`;
        const state = this.carousels.get(key);
        if (!state) {
            return;
        }

        const embed = this.buildEmbed(state, state.currentPage);
        const newMessage = await channel.send({ embeds: [embed] });

        // 保存新消息ID
        if (!messageIds[guildId]) {
            messageIds[guildId] = {};
        }
        if (!messageIds[guildId].channelCarousel) {
            messageIds[guildId].channelCarousel = {};
        }
        messageIds[guildId].channelCarousel[channelId] = newMessage.id;
        await this.saveMessageIds(messageIds);
    }

    /**
     * 更新轮播消息内容
     * @param {string} key - 轮播键（guildId-channelId）
     */
    async updateCarouselMessage(key) {
        const state = this.carousels.get(key);
        if (!state) {
            return;
        }

        const { channel, guildId, channelId, currentPage } = state;
        const messageIds = await this.loadMessageIds();
        const messageId = messageIds[guildId]?.channelCarousel?.[channelId];

        if (!messageId) {
            // 没有消息ID，创建新消息
            await this.recreateCarouselMessage(channel, guildId, channelId, messageIds);
            return;
        }

        try {
            const message = await channel.messages.fetch(messageId);
            const embed = this.buildEmbed(state, currentPage);
            await message.edit({ embeds: [embed] });
        } catch (error) {
            // 消息不存在或无法编辑，重新创建
            logTime(`[频道轮播] 无法编辑消息，重新创建 [${key}]: ${error.message}`, true);
            await this.recreateCarouselMessage(channel, guildId, channelId, messageIds);
        }
    }

    /**
     * 构建Embed
     * @param {Object} state - 轮播状态
     * @param {number} currentPage - 当前页码
     * @returns {Object} Discord Embed对象
     */
    buildEmbed(state, currentPage) {
        const { config, totalPages, pageSize } = state;
        const items = state.data;

        // 获取当前页的数据
        const startIndex = currentPage * pageSize;
        const currentPageItems = items.slice(startIndex, startIndex + pageSize);

        // 基础Embed结构
        const embed = {
            color: config.color,
            title: config.title,
            timestamp: new Date(),
        };

        // 添加页码信息到描述
        let description = config.description || '';
        if (totalPages > 1) {
            description += `\n\n📄 第 ${currentPage + 1}/${totalPages} 页 (共 ${items.length} 条，每 ${config.updateInterval} 秒切换)`;
        } else if (items.length > 0) {
            description += `\n\n📊 共 ${items.length} 条`;
        }

        // 根据排版方式构建内容
        if (config.layout.startsWith('md-')) {
            // Markdown格式
            const itemsText = currentPageItems.map((item, index) => {
                const globalIndex = startIndex + index + 1;
                if (config.layout === 'md-numbered') {
                    return `${globalIndex}. ${item.content}`;
                } else {
                    return `- ${item.content}`;
                }
            }).join('\n');

            embed.description = description + '\n\n' + itemsText;
        } else {
            // Field格式
            embed.description = description;
            embed.fields = currentPageItems.map((item, index) => {
                const globalIndex = startIndex + index + 1;
                const lines = item.content.split('\n');

                let name, value;
                if (lines.length === 1) {
                    // 单行：只有标题，内容为空
                    name = config.layout === 'field-numbered' ? `${globalIndex}. ${lines[0]}` : lines[0];
                    value = '\u200B'; // 零宽空格
                } else {
                    // 多行：第一行为标题，其余为内容
                    name = config.layout === 'field-numbered' ? `${globalIndex}. ${lines[0]}` : lines[0];
                    value = lines.slice(1).join('\n');
                }

                return { name, value, inline: false };
            });
        }

        // 添加页脚
        if (config.footer) {
            embed.footer = { text: config.footer };
        }

        return embed;
    }

    /**
     * 创建空轮播消息（当没有条目时）
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     * @param {Object} config - 轮播配置
     */
    async createEmptyCarouselMessage(channel, guildId, channelId, config) {
        const messageIds = await this.loadMessageIds();

        // 构建空状态的Embed
        const embed = {
            color: config.color,
            title: config.title,
            description: config.description + '\n\n📊 暂无条目，请使用 `/管理频道轮播 新增条目` 添加内容',
            timestamp: new Date(),
        };

        if (config.footer) {
            embed.footer = { text: config.footer };
        }

        // 创建或更新消息
        const existingMessageId = messageIds[guildId]?.channelCarousel?.[channelId];

        try {
            if (existingMessageId) {
                // 尝试更新现有消息
                const existingMessage = await channel.messages.fetch(existingMessageId);
                await existingMessage.edit({ embeds: [embed] });
                logTime(`[频道轮播] 已更新空轮播消息 [${guildId}-${channelId}]`);
            } else {
                throw new Error('需要创建新消息');
            }
        } catch (error) {
            // 创建新消息
            const newMessage = await channel.send({ embeds: [embed] });

            // 保存消息ID
            if (!messageIds[guildId]) {
                messageIds[guildId] = {};
            }
            if (!messageIds[guildId].channelCarousel) {
                messageIds[guildId].channelCarousel = {};
            }
            messageIds[guildId].channelCarousel[channelId] = newMessage.id;
            await this.saveMessageIds(messageIds);

            logTime(`[频道轮播] 已创建空轮播消息 [${guildId}-${channelId}]`);
        }
    }

    /**
     * 停止指定频道轮播
     * @param {string} guildId - 服务器ID
     * @param {string} channelId - 频道ID
     */
    stopChannelCarousel(guildId, channelId) {
        const key = `${guildId}-${channelId}`;
        const checkKey = `${key}-check`;

        // 停止轮播任务
        this.stopCarousel(key);

        // 停止检查任务
        if (this.checkJobs.has(checkKey)) {
            this.checkJobs.get(checkKey).cancel();
            this.checkJobs.delete(checkKey);
            logTime(`[频道轮播] 已停止检查任务 [${key}]`);
        }
    }

    /**
     * 停止所有轮播
     */
    stopAll() {
        super.stopAll();

        // 停止所有检查任务
        for (const [key, job] of this.checkJobs) {
            job.cancel();
        }
        this.checkJobs.clear();
    }
}

