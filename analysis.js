const { Client, Events, GatewayIntentBits, codeBlock } = require('discord.js');
const { ProxyAgent } = require('undici');
const { DiscordAPIError } = require('@discordjs/rest');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');

// Discord日志发送器类
class DiscordLogger {
    constructor(client, logChannelId) {
        this.client = client;
        this.logChannelId = logChannelId;
        this.logChannel = null;
    }

    async initialize() {
        try {
            this.logChannel = await this.client.channels.fetch(this.logChannelId);
        } catch (error) {
            throw new Error(`无法初始化日志频道: ${error.message}`);
        }
    }

    // 发送不活跃帖子列表
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

    // 发送统计报告
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

// 主函数
async function analyzeThreads(config) {
    const proxyAgent = new ProxyAgent({
        uri: config.proxyUrl,
        connect: {
            timeout: 20000,
            rejectUnauthorized: false
        }
    });

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        rest: {
            timeout: 20000,
            retries: 3
        },
        makeRequest: (url, options) => {
            options.dispatcher = proxyAgent;
            return fetch(url, options);
        }
    });

    const logTime = (message, error = false) => {
        const prefix = error ? '❌ ' : '';
        console.log(`[${new Date().toLocaleString()}] ${prefix}${message}`);
    };

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

    const failedOperations = [];
    const logger = new DiscordLogger(client, config.logThreadId);

    try {
        // 登录客户端
        await new Promise((resolve) => {
            client.once(Events.ClientReady, resolve);
            client.login(config.token);
        });
        logTime('Bot已登录');

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

    } catch (error) {
        logTime(`执行过程出错: ${error.message}`, true);
        throw error;
    } finally {
        await client.destroy();
        logTime('已断开连接');
    }
}

// 执行分析
const config = require('./config.json');
console.log('开始分析...');
analyzeThreads(config).catch(error => {
    console.error('严重错误:', error);
    process.exit(1);
});