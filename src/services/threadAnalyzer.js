import { ChannelFlags } from 'discord.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { globalBatchProcessor } from '../utils/concurrency.js';
import { handleDiscordError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 超时控制的工具函数
const withTimeout = async (promise, ms = 10000, context = '') => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`操作超时: ${context}`)), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

const MESSAGE_IDS_PATH = join(process.cwd(), 'data', 'messageIds.json');

/**
 * Discord日志管理器
 * 处理分析报告的格式化和发送
 */
export class DiscordLogger {
    /**
     * @param {Client} client - Discord客户端
     * @param {string} guildId - 服务器ID
     * @param {Object} guildConfig - 服务器配置
     */
    constructor(client, guildId, guildConfig) {
        this.client = client;
        this.guildId = guildId;
        this.logChannelId = guildConfig.automation.logThreadId;
        this.logChannel = null;
        this.messageIds = null;
    }

    /**
     * 初始化日志频道
     * @throws {Error} 如果无法获取日志频道
     */
    async initialize() {
        try {
            this.logChannel = await this.client.channels.fetch(this.logChannelId);
            // 加载或创建消息ID配置
            await this.loadMessageIds();
        } catch (error) {
            throw new Error(`无法初始化服务器 ${this.guildId} 的日志频道: ${error.message}`);
        }
    }

    async loadMessageIds() {
        try {
            const data = await fs.readFile(MESSAGE_IDS_PATH, 'utf8');
            this.messageIds = JSON.parse(data);

            // 确保所有必要的结构都存在
            if (!this.messageIds.analysisMessages) {
                this.messageIds.analysisMessages = {};
            }

            ['top10', 'statistics', 'cleanup'].forEach(type => {
                if (!this.messageIds.analysisMessages[type]) {
                    this.messageIds.analysisMessages[type] = {};
                }
            });
        } catch (error) {
            // 如果文件不存在或解析失败，创建新的配置
            logTime(`加载消息ID配置失败，将创建新配置: ${error.message}`, true);
            this.messageIds = {
                analysisMessages: {
                    top10: {},
                    statistics: {},
                    cleanup: {},
                },
            };
        }
        await this.saveMessageIds();
    }

    async saveMessageIds() {
        await fs.writeFile(MESSAGE_IDS_PATH, JSON.stringify(this.messageIds, null, 2));
    }

    async getOrCreateMessage(type) {
        const messageIds = this.messageIds.analysisMessages[type];
        const guildMessageId = messageIds[this.guildId];

        if (guildMessageId) {
            try {
                return await this.logChannel.messages.fetch(guildMessageId);
            } catch (error) {
                // 如果消息不存在，从配置中删除
                logTime(`消息ID配置中不存在消息: ${error.message}`, true);
                delete messageIds[this.guildId];
                await this.saveMessageIds();
            }
        }

        // 创建新消息
        const initialEmbed = {
            color: 0x0099ff,
            title: '正在生成报告...',
            timestamp: new Date(),
        };
        const message = await this.logChannel.send({ embeds: [initialEmbed] });

        // 确保对应的类型对象存在
        if (!this.messageIds.analysisMessages[type]) {
            this.messageIds.analysisMessages[type] = {};
        }

        // 保存新消息ID
        this.messageIds.analysisMessages[type][this.guildId] = message.id;
        await this.saveMessageIds();
        return message;
    }

    /**
     * 发送不活跃子区列表
     * 展示最不活跃的前10个非置顶子区
     * @param {Array<Object>} threadInfoArray - 子区信息数组
     */
    async sendInactiveThreadsList(threadInfoArray) {
        if (!this.logChannel) {
            throw new Error('日志频道未初始化');
        }

        // 过滤掉置顶的子区
        const nonPinnedThreads = threadInfoArray.filter(thread => !thread.isPinned);

        const embed = {
            color: 0x0099ff,
            title: '最不活跃的子区 (TOP 10)',
            description: '注：此列表不包含置顶子区',
            timestamp: new Date(),
            fields: nonPinnedThreads.slice(0, 10).map((thread, index) => ({
                name: `${index + 1}. ${thread.name}${thread.error ? ' ⚠️' : ''}`,
                value: [
                    `所属频道: ${thread.parentName}`,
                    `消息数量: ${thread.messageCount}`,
                    `不活跃时长: ${thread.inactiveHours.toFixed(1)}小时`,
                    `[🔗 链接](https://discord.com/channels/${this.guildId}/${thread.threadId})`,
                ].join('\n'),
                inline: false,
            })),
        };

        const message = await this.getOrCreateMessage('top10');
        await message.edit({ embeds: [embed] });
    }

    /**
     * 发送统计报告
     * 展示子区活跃度的整体统计信息
     * @param {Object} statistics - 统计数据
     * @param {Array<Object>} failedOperations - 失败记录
     */
    async sendStatisticsReport(statistics, failedOperations) {
        if (!this.logChannel) {
            throw new Error('日志频道未初始化');
        }

        const embed = {
            color: 0x00ff99,
            title: '子区活跃度分析报告',
            timestamp: new Date(),
            fields: [
                {
                    name: '总体统计',
                    value: [
                        `总活跃子区数: ${statistics.totalThreads}`,
                        `处理出错数量: ${statistics.processedWithErrors}`,
                        `72小时以上不活跃: ${statistics.inactiveThreads.over72h}`,
                        `48小时以上不活跃: ${statistics.inactiveThreads.over48h}`,
                        `24小时以上不活跃: ${statistics.inactiveThreads.over24h}`,
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '频道分布',
                    value: Object.values(statistics.forumDistribution)
                        .sort((a, b) => b.count - a.count)
                        .map(forum => `${forum.name}: ${forum.count}个活跃子区`)
                        .join('\n'),
                    inline: false,
                },
            ],
        };

        if (failedOperations.length > 0) {
            embed.fields.push({
                name: '处理失败记录',
                value: failedOperations
                    .slice(0, 10)
                    .map(fail => `${fail.threadName}: ${fail.operation} (${fail.error})`)
                    .join('\n'),
                inline: false,
            });
        }

        const message = await this.getOrCreateMessage('statistics');
        await message.edit({ embeds: [embed] });
    }

    /**
     * 发送清理报告
     * 展示子区清理的结果统计
     * @param {Object} statistics - 统计数据
     * @param {Array<Object>} failedOperations - 失败记录
     * @param {number} threshold - 清理阈值
     */
    async sendCleanReport(statistics, failedOperations, threshold) {
        if (!this.logChannel) {
            throw new Error('日志频道未初始化');
        }

        const embed = {
            color: 0xff9900,
            title: '子区清理报告',
            timestamp: new Date(),
            fields: [
                {
                    name: '清理统计',
                    value: [
                        `总活跃子区数: ${statistics.totalThreads}`,
                        `已清理子区数: ${statistics.archivedThreads}`,
                        `跳过置顶子区: ${statistics.skippedPinnedThreads}`,
                        `上次清理阈值: ${threshold}`,
                    ].join('\n'),
                    inline: false,
                },
            ],
        };

        if (failedOperations.length > 0) {
            embed.fields.push({
                name: '清理失败记录',
                value: failedOperations
                    .slice(0, 10)
                    .map(fail => `${fail.threadName}: ${fail.operation} (${fail.error})`)
                    .join('\n'),
                inline: false,
            });
        }

        const message = await this.getOrCreateMessage('cleanup');
        await message.edit({ embeds: [embed] });
    }
}

/**
 * 收集并分析子区数据
 * @private
 */
const analyzeThreadsData = async (client, guildId, activeThreads = null) => {
    if (!activeThreads) {
        const guild = await client.guilds.fetch(guildId).catch(error => {
            throw new Error(`获取服务器失败: ${handleDiscordError(error)}`);
        });

        activeThreads = await guild.channels.fetchActiveThreads().catch(error => {
            throw new Error(`获取活跃主题列表失败: ${handleDiscordError(error)}`);
        });
    }

    const statistics = {
        totalThreads: activeThreads.threads.size,
        archivedThreads: 0,
        skippedPinnedThreads: 0,
        processedWithErrors: 0,
        inactiveThreads: {
            over72h: 0,
            over48h: 0,
            over24h: 0,
        },
        forumDistribution: {},
    };

    const failedOperations = [];
    const currentTime = Date.now();
    const threadArray = Array.from(activeThreads.threads.values());

    // 使用globalBatchProcessor处理消息获取
    const batchResults = await globalBatchProcessor.processBatch(
        threadArray,
        async thread => {
            try {
                // 处理置顶子区的反应
                if (thread.flags.has(ChannelFlags.Pinned)) {
                    try {
                        const messages = await withTimeout(
                            thread.messages.fetch({ limit: 1 }),
                            5000,
                            `获取置顶子区消息 ${thread.name}`,
                        );
                        const lastMessage = messages.first();
                        if (lastMessage) {
                            await withTimeout(
                                Promise.all([
                                    lastMessage.react('🔄'),
                                    new Promise(resolve => setTimeout(resolve, 1000)).then(() => {
                                        const reaction = lastMessage.reactions.cache.find(r => r.emoji.name === '🔄');
                                        return reaction?.users.remove(client.user.id);
                                    }),
                                ]),
                                5000,
                                `处理置顶子区反应 ${thread.name}`,
                            );
                        }
                    } catch (error) {
                        logTime(`为置顶子区 ${thread.name} 添加反应失败: ${handleDiscordError(error)}`, true);
                        // 继续执行，不中断流程
                    }
                }

                // 获取子区消息
                let lastMessage = null;
                try {
                    const messages = await withTimeout(
                        thread.messages.fetch({ limit: 1 }),
                        5000,
                        `获取子区消息 ${thread.name}`,
                    );
                    lastMessage = messages.first();

                    if (!lastMessage) {
                        const moreMessages = await withTimeout(
                            thread.messages.fetch({ limit: 3 }),
                            5000,
                            `获取更多子区消息 ${thread.name}`,
                        );
                        lastMessage = moreMessages.find(msg => msg !== null);
                    }
                } catch (error) {
                    logTime(`获取子区 ${thread.name} 消息失败: ${handleDiscordError(error)}`, true);
                    // 使用子区创建时间作为备选
                    lastMessage = null;
                }

                const lastActiveTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                const inactiveHours = (currentTime - lastActiveTime) / (1000 * 60 * 60);

                return {
                    thread,
                    threadId: thread.id,
                    name: thread.name,
                    parentId: thread.parentId,
                    parentName: thread.parent?.name || '未知论坛',
                    lastMessageTime: lastActiveTime,
                    inactiveHours,
                    messageCount: thread.messageCount || 0,
                    isPinned: thread.flags.has(ChannelFlags.Pinned),
                };
            } catch (error) {
                failedOperations.push({
                    threadId: thread.id,
                    threadName: thread.name,
                    operation: '获取消息历史',
                    error: handleDiscordError(error),
                });
                statistics.processedWithErrors++;
                return null;
            }
        },
        null,
        'threadAnalysis',
    );

    const validThreads = batchResults
        .filter(result => result !== null)
        .sort((a, b) => b.inactiveHours - a.inactiveHours);

    // 合并统计
    validThreads.forEach(thread => {
        if (thread.inactiveHours >= 72) {
            statistics.inactiveThreads.over72h++;
        }
        if (thread.inactiveHours >= 48) {
            statistics.inactiveThreads.over48h++;
        }
        if (thread.inactiveHours >= 24) {
            statistics.inactiveThreads.over24h++;
        }

        if (!statistics.forumDistribution[thread.parentId]) {
            statistics.forumDistribution[thread.parentId] = {
                name: thread.parentName,
                count: 0,
            };
        }
        statistics.forumDistribution[thread.parentId].count++;
    });

    return { statistics, failedOperations, validThreads };
};

/**
 * 执行子区清理
 * @private
 */
const cleanupThreads = async (validThreads, threshold) => {
    const statistics = {
        totalThreads: validThreads.length,
        archivedThreads: 0,
        skippedPinnedThreads: 0,
        processedWithErrors: 0,
    };
    const failedOperations = [];

    // 计算需要归档的数量，考虑置顶帖
    const pinnedCount = validThreads.filter(t => t.isPinned).length;
    statistics.skippedPinnedThreads = pinnedCount;

    const targetCount = Math.max(threshold - pinnedCount, 0);
    const nonPinnedThreads = validThreads.filter(t => !t.isPinned);

    if (nonPinnedThreads.length > targetCount) {
        const threadsToArchive = nonPinnedThreads.slice(0, nonPinnedThreads.length - targetCount);

        for (const threadInfo of threadsToArchive) {
            try {
                await threadInfo.thread.setArchived(true, '自动清理不活跃主题');
                statistics.archivedThreads++;
            } catch (error) {
                failedOperations.push({
                    threadId: threadInfo.threadId,
                    threadName: threadInfo.name,
                    operation: '归档主题',
                    error: handleDiscordError(error),
                });
                statistics.processedWithErrors++;
            }
        }
    }

    return { statistics, failedOperations };
};

/**
 * 分析子区活跃度并生成报告
 */
export const analyzeForumActivity = async (client, guildConfig, guildId, activeThreads = null) => {
    const totalTimer = measureTime();
    logTime(`开始分析服务器 ${guildId} 的子区活跃度`);

    const logger = new DiscordLogger(client, guildId, guildConfig);

    try {
        await logger.initialize();

        // 收集数据
        const { statistics, failedOperations, validThreads } = await analyzeThreadsData(client, guildId, activeThreads);

        // 生成报告
        await logger.sendInactiveThreadsList(validThreads);
        await logger.sendStatisticsReport(statistics, failedOperations);

        const executionTime = totalTimer();
        logTime(`活跃度分析完成 - 处理了 ${statistics.totalThreads} 个子区，用时: ${executionTime}秒`);
        return { statistics, failedOperations, validThreads };
    } catch (error) {
        logTime(`服务器 ${guildId} 活跃度分析失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 清理不活跃子区
 */
export const cleanupInactiveThreads = async (client, guildConfig, guildId, threshold, activeThreads = null) => {
    const totalTimer = measureTime();
    logTime(`开始清理服务器 ${guildId} 的不活跃子区`);

    const logger = new DiscordLogger(client, guildId, guildConfig);

    try {
        await logger.initialize();

        // 收集数据
        const { statistics, failedOperations, validThreads } = await analyzeThreadsData(client, guildId, activeThreads);

        // 执行清理
        const cleanupResult = await cleanupThreads(validThreads, threshold);

        // 合并统计结果
        Object.assign(statistics, cleanupResult.statistics);
        failedOperations.push(...cleanupResult.failedOperations);

        // 生成报告
        await logger.sendCleanReport(statistics, failedOperations, threshold);

        const executionTime = totalTimer();
        logTime(`清理操作完成 - 清理了 ${cleanupResult.statistics.archivedThreads} 个子区，用时: ${executionTime}秒`);
        return { statistics, failedOperations };
    } catch (error) {
        logTime(`服务器 ${guildId} 清理操作失败: ${error.message}`, true);
        throw error;
    }
};
