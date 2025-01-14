const { ProxyAgent } = require('undici');
const { DiscordAPIError } = require('@discordjs/rest');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const { codeBlock } = require('discord.js');

/**
 * Discord日志发送器类
 * 用于处理向指定频道发送分析报告的逻辑
 */
class DiscordLogger {
    /**
     * @param {Client} client - Discord.js客户端实例
     * @param {string} logChannelId - 日志频道ID
     */
    constructor(client, logChannelId) {
        this.client = client;
        this.logChannelId = logChannelId;
        this.logChannel = null;
    }

    /**
     * 初始化日志频道
     * @throws {Error} 如果无法获取日志频道
     */
    async initialize() {
        try {
            this.logChannel = await this.client.channels.fetch(this.logChannelId);
        } catch (error) {
            throw new Error(`无法初始化日志频道: ${error.message}`);
        }
    }

    /**
     * 发送不活跃帖子列表
     * @param {Array<Object>} threadInfoArray - 帖子信息数组
     * @throws {Error} 如果日志频道未初始化
     */
    async sendInactiveThreadsList(threadInfoArray) {
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const inactiveThreadsMessage = [
            '# 最不活跃的帖子 (TOP 10)',
            '',
            ...threadInfoArray.slice(0, 10).map((thread, index) => [
                `${index + 1}. ${thread.name}${thread.error ? ' ⚠️' : ''}`,
                `   📌 所属论坛: ${thread.parentName}`,
                `   💬 消息数量: ${thread.messageCount}`,
                `   ⏰ 不活跃时长: ${thread.inactiveHours.toFixed(1)}小时`,
                ''
            ].join('\n'))
        ].join('\n');

        await this.logChannel.send(codeBlock('md', inactiveThreadsMessage));
    }

    /**
     * 发送统计报告
     * @param {Object} statistics - 统计数据对象
     * @param {Array<Object>} failedOperations - 失败操作记录
     * @throws {Error} 如果日志频道未初始化
     */
    async sendStatisticsReport(statistics, failedOperations) {
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const summaryMessage = [
            '# 论坛活跃度分析报告',
            '',
            '## 总体统计',
            `- 总活跃主题数: ${statistics.totalThreads}`,
            `- 处理出错数量: ${statistics.processedWithErrors}`,
            `- 72小时以上不活跃: ${statistics.inactiveThreads.over72h}`,
            `- 48小时以上不活跃: ${statistics.inactiveThreads.over48h}`,
            `- 24小时以上不活跃: ${statistics.inactiveThreads.over24h}`,
            '',
            '## 论坛分布',
            ...Object.values(statistics.forumDistribution)
                .sort((a, b) => b.count - a.count)
                .map(forum => `- ${forum.name}: ${forum.count}个活跃主题`),
            '',
            failedOperations.length > 0 ? [
                '## 处理失败记录',
                ...failedOperations.map(fail =>
                    `- ${fail.threadName}: ${fail.operation} (${fail.error})`
                )
            ].join('\n') : ''
        ].join('\n');

        await this.logChannel.send(codeBlock('md', summaryMessage));
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
 * 记录时间日志
 * @param {string} message - 日志消息
 * @param {boolean} [error=false] - 是否为错误日志
 */
const logTime = (message, error = false) => {
    const prefix = error ? '❌ ' : '';
    console.log(`[${new Date().toLocaleString()}] ${prefix}${message}`);
};

/**
 * 主要分析函数
 * @param {Object} config - 配置对象
 * @param {string} config.guildId - 服务器ID
 * @param {string} config.logThreadId - 日志频道ID
 * @param {string} config.proxyUrl - 代理URL
 * @returns {Promise<void>}
 */
async function analyzeThreads(client, config) {
    const failedOperations = [];
    const logger = new DiscordLogger(client, config.logThreadId);

    try {
        await logger.initialize();
        logTime('日志系统已初始化');

        // 获取服务器
        const guild = await client.guilds.fetch(config.guildId)
            .catch(error => {
                throw new Error(`获取服务器失败: ${handleDiscordError(error)}`);
            });

        // 获取活跃主题
        const activeThreads = await guild.channels.fetchActiveThreads()
            .catch(error => {
                throw new Error(`获取活跃主题列表失败: ${handleDiscordError(error)}`);
            });

        logTime(`已找到 ${activeThreads.threads.size} 个活跃主题`);

        // 收集主题信息
        const currentTime = Date.now();
        const threadInfoArray = await Promise.all(
            Array.from(activeThreads.threads.values()).map(async (thread) => {
                try {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMessage = messages.first();
                    const lastActiveTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                    const inactiveHours = (currentTime - lastActiveTime) / (1000 * 60 * 60);

                    return {
                        threadId: thread.id,
                        name: thread.name,
                        parentId: thread.parentId,
                        parentName: thread.parent?.name || '未知论坛',
                        lastMessageTime: lastActiveTime,
                        inactiveHours: inactiveHours,
                        messageCount: thread.messageCount || 0
                    };
                } catch (error) {
                    failedOperations.push({
                        threadId: thread.id,
                        threadName: thread.name,
                        operation: '获取消息历史',
                        error: handleDiscordError(error)
                    });

                    return {
                        threadId: thread.id,
                        name: thread.name,
                        parentId: thread.parentId,
                        parentName: thread.parent?.name || '未知论坛',
                        lastMessageTime: thread.createdTimestamp,
                        inactiveHours: (currentTime - thread.createdTimestamp) / (1000 * 60 * 60),
                        messageCount: thread.messageCount || 0,
                        error: true
                    };
                }
            })
        );

        // 按不活跃时间排序
        threadInfoArray.sort((a, b) => b.inactiveHours - a.inactiveHours);

        // 计算统计数据
        const statistics = {
            totalThreads: threadInfoArray.length,
            processedWithErrors: threadInfoArray.filter(t => t.error).length,
            inactiveThreads: {
                over72h: threadInfoArray.filter(t => t.inactiveHours >= 72).length,
                over48h: threadInfoArray.filter(t => t.inactiveHours >= 48).length,
                over24h: threadInfoArray.filter(t => t.inactiveHours >= 24).length
            },
            forumDistribution: {}
        };

        // 统计论坛分布
        threadInfoArray.forEach(thread => {
            if (!statistics.forumDistribution[thread.parentId]) {
                statistics.forumDistribution[thread.parentId] = {
                    name: thread.parentName,
                    count: 0
                };
            }
            statistics.forumDistribution[thread.parentId].count++;
        });

        // 发送不活跃帖子列表
        await logger.sendInactiveThreadsList(threadInfoArray);
        logTime('已发送不活跃帖子列表');

        // 发送完整统计报告
        await logger.sendStatisticsReport(statistics, failedOperations);
        logTime('已发送统计报告');

        return {
            success: true,
            statistics,
            failedOperations
        };

    } catch (error) {
        logTime(`执行过程出错: ${error.message}`, true);
        throw error;
    }
}

module.exports = {
    analyzeThreads,
    DiscordLogger
};