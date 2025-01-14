const { Client, Events, GatewayIntentBits, codeBlock } = require('discord.js');
const { token, guildId, logThreadId, proxyUrl } = require('./config.json');
const { ProxyAgent } = require('undici');
const { DiscordAPIError } = require('@discordjs/rest');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');

const proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

async function analyzeThreads(guildId) {
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

    // 解析Discord API错误
    const handleDiscordError = (error, context) => {
        if (error instanceof DiscordAPIError) {
            switch (error.code) {
                case RESTJSONErrorCodes.UnknownChannel:
                    return '频道不存在或无法访问';
                case RESTJSONErrorCodes.MissingAccess:
                    return '缺少访问权限';
                case RESTJSONErrorCodes.UnknownMessage:
                    return '消息不存在或已被删除';
                case RESTJSONErrorCodes.MissingPermissions:
                    return '缺少所需权限';
                case RESTJSONErrorCodes.InvalidThreadChannel:
                    return '无效的主题频道';
                default:
                    return `Discord API错误 (${error.code}): ${error.message}`;
            }
        }
        return error.message || '未知错误';
    };

    const failedOperations = [];

    try {
        await new Promise((resolve) => {
            client.once(Events.ClientReady, resolve);
            client.login(token);
        });
        logTime('Bot已登录');

        let guild;
        try {
            guild = await client.guilds.fetch(guildId);
        } catch (error) {
            logTime(`获取服务器失败: ${handleDiscordError(error)}`, true);
            throw error;
        }

        let activeThreads;
        try {
            activeThreads = await guild.channels.fetchActiveThreads();
            logTime(`已找到 ${activeThreads.threads.size} 个活跃主题`);
        } catch (error) {
            logTime(`获取活跃主题列表失败: ${handleDiscordError(error)}`, true);
            throw error;
        }

        // 获取每个帖子的详细信息
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

        // 输出最不活跃的10个帖子
        console.log('\n最不活跃的10个帖子:');
        threadInfoArray.slice(0, 10).forEach((thread, index) => {
            console.log(`${index + 1}. ${thread.name}${thread.error ? ' (⚠️数据可能不完整)' : ''}`);
            console.log(`   所属论坛: ${thread.parentName}`);
            console.log(`   消息数量: ${thread.messageCount}`);
            console.log(`   不活跃时长: ${thread.inactiveHours.toFixed(1)}小时`);
            console.log('');
        });

        // 统计数据
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

        // 仅统计论坛分布
        threadInfoArray.forEach(thread => {
            if (!statistics.forumDistribution[thread.parentId]) {
                statistics.forumDistribution[thread.parentId] = {
                    name: thread.parentName,
                    count: 0
                };
            }
            statistics.forumDistribution[thread.parentId].count++;
        });

        // 发送简化的统计结果到日志频道
        try {
            const logChannel = await client.channels.fetch(logThreadId);
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
                    .sort((a, b) => b.count - a.count) // 按活跃数量降序排序
                    .map(forum => `- ${forum.name}: ${forum.count}个活跃主题`),
                '',
                failedOperations.length > 0 ? [
                    '## 处理失败记录',
                    ...failedOperations.map(fail =>
                        `- ${fail.threadName}: ${fail.operation} (${fail.error})`
                    )
                ].join('\n') : ''
            ].join('\n');

            await logChannel.send(codeBlock('md', summaryMessage));
            logTime('分析报告已发送到日志频道');
        } catch (error) {
            logTime(`发送分析报告失败: ${handleDiscordError(error)}`, true);
        }

    } catch (error) {
        logTime(`执行过程出错: ${handleDiscordError(error)}`, true);
        throw error;
    } finally {
        await client.destroy();
        logTime('已断开连接');
    }
}

// 执行分析
console.log('开始分析...');
analyzeThreads(guildId)
    .catch(error => {
        console.error('严重错误:', error);
        process.exit(1);
    });
