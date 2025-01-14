const { DiscordAPIError } = require('@discordjs/rest');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const { codeBlock, ChannelFlags } = require('discord.js');
const { logTime, delay, measureTime } = require('./common');

/**
 * Discord分析报告发送器类
 * 用于处理分析结果的格式化和发送
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

    /**
     * 发送清理报告
     * @param {Object} statistics - 统计数据对象
     * @param {Array<Object>} failedOperations - 失败操作记录
     * @param {number} threshold - 清理阈值
     * @throws {Error} 如果日志频道未初始化
     */
    async sendCleanReport(statistics, failedOperations, threshold) {
        if (!this.logChannel) throw new Error('日志频道未初始化');

        const cleanReport = [
            '# 主题清理报告',
            '',
            '## 清理统计',
            `- 总活跃主题数: ${statistics.totalThreads}`,
            `- 已清理主题数: ${statistics.archivedThreads}`,
            `- 跳过置顶主题: ${statistics.skippedPinnedThreads}`,
            `- 清理阈值: ${threshold}`,
            '',
            failedOperations.length > 0 ? [
                '## 清理失败记录',
                ...failedOperations.map(fail =>
                    `- ${fail.threadName}: ${fail.operation} (${fail.error})`
                )
            ].join('\n') : ''
        ].join('\n');

        await this.logChannel.send(codeBlock('md', cleanReport));
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
 * 分析Discord论坛主题的活跃度
 * @param {Client} client - Discord.js客户端实例
 * @param {Object} config - 配置对象
 * @param {string} config.guildId - 服务器ID
 * @param {string} config.logThreadId - 日志频道ID
 * @param {string} config.proxyUrl - 代理URL（可选）
 * @param {Object} options - 可选配置
 * @param {boolean} options.clean - 是否执行清理操作
 * @param {number} options.threshold - 清理阈值
 * @param {Collection} activeThreads - 预先获取的活跃主题集合（可选）
 * @returns {Promise<Object>} 返回统计结果和失败操作记录
 */
async function analyzeThreads(client, config, options = {}, activeThreads = null) {
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
    const logger = new DiscordLogger(client, config.logThreadId);

    try {
        await logger.initialize();
        logTime('日志系统已初始化');

        // 如果没有传入 activeThreads，则获取
        if (!activeThreads) {
            const guild = await client.guilds.fetch(config.guildId)
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
        logTime(`已找到 ${statistics.totalThreads} 个活跃主题`);

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
        if (options.clean && options.threshold) {
            const archiveTimer = measureTime();

            // 计算需要归档的数量，考虑置顶帖
            const pinnedCount = validThreads.filter(t => t.isPinned).length;
            const targetCount = Math.max(options.threshold - pinnedCount, 0);
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
        logTime(`执行过程出错: ${error.message}`, true);
        throw error;
    }
}

module.exports = {
    analyzeThreads,
    DiscordLogger
};