const { DiscordAPIError } = require('@discordjs/rest');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const { codeBlock, ChannelFlags } = require('discord.js');
const { logTime, delay, measureTime } = require('./common');
const fs = require('fs').promises;
const path = require('path');
const MESSAGE_IDS_PATH = path.join(__dirname, '../data/messageIds.json');

/**
 * Discord日志管理器
 * 处理分析报告的格式化和发送
 */
class DiscordLogger {
    /**
     * @param {Client} client - Discord客户端
     * @param {string} guildId - 服务器ID
     * @param {Object} guildConfig - 服务器配置
     */
    constructor(client, guildId, guildConfig) {
        this.client = client;
        this.guildId = guildId;
        this.logChannelId = guildConfig.logThreadId;
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
            this.messageIds = {
                analysisMessages: {
                    top10: {},
                    statistics: {},
                    cleanup: {}
                }
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
                delete messageIds[this.guildId];
                await this.saveMessageIds();
            }
        }

        // 创建新消息
        const initialEmbed = {
            color: 0x0099ff,
            title: '正在生成报告...',
            timestamp: new Date()
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
     * 展示最不活跃的前10个子区
     * @param {Array<Object>} threadInfoArray - 子区信息数组
     */
    async sendInactiveThreadsList(threadInfoArray) {
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const embed = {
            color: 0x0099ff,
            title: '最不活跃的子区 (TOP 10)',
            description: `上次更新: ${new Date().toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            })}`,
            timestamp: new Date(),
            fields: threadInfoArray.slice(0, 10).map((thread, index) => ({
                name: `${index + 1}. ${thread.name}${thread.error ? ' ⚠️' : ''}`,
                value: [
                    `所属频道: ${thread.parentName}`,
                    `消息数量: ${thread.messageCount}`,
                    `不活跃时长: ${thread.inactiveHours.toFixed(1)}小时`
                ].join('\n'),
                inline: false
            }))
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
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const embed = {
            color: 0x00ff99,
            title: '子区活跃度分析报告',
            description: `上次更新: ${new Date().toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            })}`,
            timestamp: new Date(),
            fields: [
                {
                    name: '总体统计',
                    value: [
                        `总活跃子区数: ${statistics.totalThreads}`,
                        `处理出错数量: ${statistics.processedWithErrors}`,
                        `72小时以上不活跃: ${statistics.inactiveThreads.over72h}`,
                        `48小时以上不活跃: ${statistics.inactiveThreads.over48h}`,
                        `24小时以上不活跃: ${statistics.inactiveThreads.over24h}`
                    ].join('\n'),
                    inline: false
                },
                {
                    name: '频道分布',
                    value: Object.values(statistics.forumDistribution)
                        .sort((a, b) => b.count - a.count)
                        .map(forum => `${forum.name}: ${forum.count}个活跃子区`)
                        .join('\n'),
                    inline: false
                }
            ]
        };

        if (failedOperations.length > 0) {
            embed.fields.push({
                name: '处理失败记录',
                value: failedOperations
                    .slice(0, 10)
                    .map(fail => `${fail.threadName}: ${fail.operation} (${fail.error})`)
                    .join('\n'),
                inline: false
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
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const embed = {
            color: 0xff9900,
            title: '子区清理报告',
            description: `上次更新: ${new Date().toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false
            })}`,
            timestamp: new Date(),
            fields: [
                {
                    name: '清理统计',
                    value: [
                        `总活跃子区数: ${statistics.totalThreads}`,
                        `已清理子区数: ${statistics.archivedThreads}`,
                        `跳过置顶子区: ${statistics.skippedPinnedThreads}`,
                        `上次清理阈值: ${threshold}`
                    ].join('\n'),
                    inline: false
                }
            ]
        };

        if (failedOperations.length > 0) {
            embed.fields.push({
                name: '清理失败记录',
                value: failedOperations
                    .slice(0, 10)
                    .map(fail => `${fail.threadName}: ${fail.operation} (${fail.error})`)
                    .join('\n'),
                inline: false
            });
        }

        const message = await this.getOrCreateMessage('cleanup');
        await message.edit({ embeds: [embed] });
    }
}

/**
 * 处理Discord API错误
 * @param {Error} error - 错误对象
 * @returns {string} 格式化的错误信息
 */
const handleDiscordError = (error) => {
    if (error instanceof DiscordAPIError) {
        const errorMessages = {
            [RESTJSONErrorCodes.UnknownChannel]: '频道不存在或无法访问',
            [RESTJSONErrorCodes.MissingAccess]: '缺少访问权限',
            [RESTJSONErrorCodes.UnknownMessage]: '消息不存在或已被删除',
            [RESTJSONErrorCodes.MissingPermissions]: '缺少所需权限',
            [RESTJSONErrorCodes.InvalidThreadChannel]: '无效的主题频道'
        };
        return errorMessages[error.code] || `Discord API错误 (${error.code}): ${error.message}`;
    }
    return error.message || '未知错误';
};

/**
 * 分析Discord子区活跃度
 * 收集并分析所有子区的活跃状态，支持清理功能
 * @param {Client} client - Discord客户端
 * @param {Object} guildConfig - 服务器配置
 * @param {string} guildId - 服务器ID
 * @param {Object} options - 可选配置
 * @param {Collection} activeThreads - 预获取的活跃子区集合
 * @returns {Promise<Object>} 统计结果和失败记录
 */
async function analyzeThreads(client, guildConfig, guildId, options = {}, activeThreads = null) {
    const totalTimer = measureTime();
    const statistics = {
        totalThreads: 0,
        archivedThreads: 0,
        skippedPinnedThreads: 0,
        processedWithErrors: 0,
        inactiveThreads: {
            over72h: 0,
            over48h: 0,
            over24h: 0
        },
        forumDistribution: {}
    };
    
    const failedOperations = [];
    const logger = new DiscordLogger(client, guildId, guildConfig);

    // 添加默认阈值处理
    if (options.clean) {
        options.threshold = options.threshold || 960;
        logTime(`清理阈值设置为: ${options.threshold}`);
    }
    
    try {
        await logger.initialize();
        logTime('日志系统已初始化');

        // 如果没有传入 activeThreads，则获取
        if (!activeThreads) {
            const guild = await client.guilds.fetch(guildId)
                .catch(error => {
                    throw new Error(`获取服务器失败: ${handleDiscordError(error)}`);
                });

            const fetchThreadsTimer = measureTime();
            activeThreads = await guild.channels.fetchActiveThreads()
                .catch(error => {
                    throw new Error(`获取活跃主题列表失败: ${handleDiscordError(error)}`);
                });
            logTime(`获取活跃主题列表用时: ${fetchThreadsTimer()}秒`);
        }

        statistics.totalThreads = activeThreads.threads.size;
        logTime(`服务器 ${guildId} 已找到 ${statistics.totalThreads} 个活跃子区`);

        // 收集主题信息计时
        const processThreadsTimer = measureTime();
        const currentTime = Date.now();
        const batchSize = 50; // 批处理大小
        const threadArray = Array.from(activeThreads.threads.values());
        const threadInfoArray = [];

        // 添加进度输出函数
        const logProgress = (current, total) => {
            const progress = (current / total * 100).toFixed(1);
            logTime(`已处理 ${current}/${total} 个主题 (${progress}%)`);
        };

        // 设置进度报告的间隔
        const progressIntervals = [25, 50, 75, 100];
        let lastProgressIndex = -1;

        for (let i = 0; i < threadArray.length; i += batchSize) {
            const batch = threadArray.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (thread) => {
                    try {
                        await delay(5); // 延迟5ms
                        const messages = await thread.messages.fetch({ limit: 1 });
                        const lastMessage = messages.first();
                        const lastActiveTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                        const inactiveHours = (currentTime - lastActiveTime) / (1000 * 60 * 60);

                        return {
                            thread: thread,
                            threadId: thread.id,
                            name: thread.name,
                            parentId: thread.parentId,
                            parentName: thread.parent?.name || '未知论坛',
                            lastMessageTime: lastActiveTime,
                            inactiveHours: inactiveHours,
                            messageCount: thread.messageCount || 0,
                            isPinned: thread.flags.has(ChannelFlags.Pinned)
                        };
                    } catch (error) {
                        failedOperations.push({
                            threadId: thread.id,
                            threadName: thread.name,
                            operation: '获取消息历史',
                            error: handleDiscordError(error)
                        });
                        statistics.processedWithErrors++;
                        return null;
                    }
                })
            );
            threadInfoArray.push(...batchResults);

            // 计算当前进度百分比
            const currentProgress = ((i + batchSize) / threadArray.length * 100);
            
            // 检查是否达到下一个进度间隔点
            const progressIndex = progressIntervals.findIndex(interval => 
                currentProgress >= interval && interval > (lastProgressIndex >= 0 ? progressIntervals[lastProgressIndex] : 0)
            );

            if (progressIndex !== -1 && progressIndex > lastProgressIndex) {
                logProgress(Math.min(i + batchSize, threadArray.length), threadArray.length);
                lastProgressIndex = progressIndex;
            }
        }
        logTime(`处理所有主题信息用时: ${processThreadsTimer()}秒`);

        // 在清理操作之前就处理有效的线程数组
        const validThreads = threadInfoArray.filter(t => t !== null)
            .sort((a, b) => b.inactiveHours - a.inactiveHours);

        // 清理操作计时
        if (options.clean) {
            const archiveTimer = measureTime();
            const threshold = options.threshold;  // 使用已处理过的阈值
            
            // 计算需要归档的数量，考虑置顶帖
            const pinnedCount = validThreads.filter(t => t.isPinned).length;
            const targetCount = Math.max(threshold - pinnedCount, 0);
            const nonPinnedThreads = validThreads.filter(t => !t.isPinned);
            
            if (nonPinnedThreads.length > targetCount) {
                const threadsToArchive = nonPinnedThreads
                    .slice(0, nonPinnedThreads.length - targetCount);

                logTime(`开始归档 ${threadsToArchive.length} 个主题...`);
                for (const threadInfo of threadsToArchive) {
                    try {
                        await delay(50); // 归档操作保持50ms延迟
                        await threadInfo.thread.setArchived(true, '自动清理不活跃主题');
                        statistics.archivedThreads++;
                        if (statistics.archivedThreads % 25 === 0) {
                            logTime(`已归档 ${statistics.archivedThreads}/${threadsToArchive.length} 个主题`);
                        }
                    } catch (error) {
                        failedOperations.push({
                            threadId: threadInfo.threadId,
                            threadName: threadInfo.name,
                            operation: '归档主题',
                            error: handleDiscordError(error)
                        });
                    }
                }
            }
            logTime(`归档操作用时: ${archiveTimer()}秒`);
        }

        // 统计不活跃时间
        validThreads.forEach(thread => {
            if (thread.inactiveHours >= 72) statistics.inactiveThreads.over72h++;
            if (thread.inactiveHours >= 48) statistics.inactiveThreads.over48h++;
            if (thread.inactiveHours >= 24) statistics.inactiveThreads.over24h++;
        });

        // 统计论坛分布
        validThreads.forEach(thread => {
            if (!statistics.forumDistribution[thread.parentId]) {
                statistics.forumDistribution[thread.parentId] = {
                    name: thread.parentName,
                    count: 0
                };
            }
            statistics.forumDistribution[thread.parentId].count++;
        });

        // 发送报告
        if (options.clean) {
            await logger.sendCleanReport(statistics, failedOperations, options.threshold);
        } else {
            await logger.sendInactiveThreadsList(validThreads);
            await logger.sendStatisticsReport(statistics, failedOperations);
        }

        logTime(`总执行时间: ${totalTimer()}秒`);
        return {
            statistics,
            failedOperations
        };

    } catch (error) {
        logTime(`服务器 ${guildId} 执行过程出错: ${error.message}`, true);
        throw error;
    }
}

module.exports = {
    analyzeThreads,
    DiscordLogger
};