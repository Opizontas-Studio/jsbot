// 导入必要的Discord.js组件
const { Client, Events, GatewayIntentBits } = require('discord.js');
// 从配置文件导入设置
const { token, guildId, logThreadId, threshold, zombieHours, proxyUrl, pinnedThreads, diagnosticMode } = require('./config.json');
// 导入网络代理工具
const { ProxyAgent } = require('undici');
// 导入Discord API错误类型
const { DiscordAPIError } = require('@discordjs/rest');

const proxyAgent = new ProxyAgent({
    uri: 'http://127.0.0.1:7890',
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

async function getAndSortActiveThreads(guildId) {
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

    const logTime = (message) => {
        console.log(`[${new Date().toLocaleString()}] ${message}`);
    };

    try {
        // 登录计时开始
        const loginStartTime = Date.now();
        logTime('正在连接Discord...');

        await new Promise((resolve) => {
            client.once(Events.ClientReady, (readyClient) => {
                logTime(`Bot已登录为 ${readyClient.user.tag}`);
                resolve();
            });
            client.login(token);
        });

        const loginTime = Date.now() - loginStartTime;
        logTime(`登录完成，耗时: ${loginTime}ms`);

        // 获取服务器和线程计时开始
        const fetchStartTime = Date.now();
        const guild = await client.guilds.fetch(guildId);
        logTime(`已找到服务器: ${guild.name}`);

        const { threads } = await guild.channels.fetchActiveThreads();
        logTime(`共找到 ${threads.size} 个活跃主题`);

        // 获取消息计时开始
        const messagesFetchStartTime = Date.now();
        const threadInfoArray = await Promise.all(
            Array.from(threads.values()).map(async (thread) => {
                try {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMessage = messages.first();

                    return {
                        name: thread.name,
                        lastMessageTime: lastMessage
                            ? lastMessage.createdTimestamp
                            : thread.createdTimestamp,
                        lastMessageAt: lastMessage
                            ? lastMessage.createdAt.toLocaleString()
                            : thread.createdAt.toLocaleString(),
                        isCreateTime: !lastMessage,
                        messageCount: thread.messageCount || 0,
                        // 添加消息内容预览
                        messagePreview: lastMessage
                            ? lastMessage.content.slice(0, 10) + (lastMessage.content.length > 10 ? '...' : '')
                            : '无消息'
                    };
                } catch (error) {
                    logTime(`获取主题 "${thread.name}" 的消息时出错: ${error.message}`);
                    return {
                        name: thread.name,
                        lastMessageTime: thread.createdTimestamp,
                        lastMessageAt: thread.createdAt.toLocaleString(),
                        isCreateTime: true,
                        messageCount: thread.messageCount || 0,
                        messagePreview: '获取失败',
                        error: error.message
                    };
                }
            })
        );

        const messagesFetchTime = Date.now() - messagesFetchStartTime;
        logTime(`消息获取完成，耗时: ${messagesFetchTime}ms`);

        // 排序计时开始
        const sortStartTime = Date.now();
        threadInfoArray.sort((a, b) => a.lastMessageTime - b.lastMessageTime);
        const sortTime = Date.now() - sortStartTime;
        logTime(`排序完成，耗时: ${sortTime}ms`);

        // 输出计时开始
        const outputStartTime = Date.now();
        logTime('按最后活跃时间排序的主题列表:');
        console.log('\n排序结果:');
        threadInfoArray.forEach((thread, index) => {
            console.log(`${index + 1}. ${thread.name}`);
            console.log(`   消息数量: ${thread.messageCount}`);
            console.log(`   最后消息: ${thread.messagePreview}`);
            console.log(`   最后活跃: ${thread.lastMessageAt}${thread.isCreateTime ? ' (使用创建时间)' : ''}`);
            if (thread.error) {
                console.log(`   错误信息: ${thread.error}`);
            }
            console.log(''); // 空行分隔
        });

        const outputTime = Date.now() - outputStartTime;
        logTime(`输出完成，耗时: ${outputTime}ms`);

        // 总计时统计
        const totalTime = Date.now() - loginStartTime;
        logTime('\n性能统计:');
        logTime(`登录耗时: ${loginTime}ms`);
        logTime(`获取服务器和线程耗时: ${messagesFetchStartTime - fetchStartTime}ms`);
        logTime(`获取消息耗时: ${messagesFetchTime}ms`);
        logTime(`输出耗时: ${outputTime}ms`);
        logTime(`总耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`);

        return {
            threadInfoArray,
            timing: {
                login: loginTime,
                fetch: messagesFetchStartTime - fetchStartTime,
                messagesFetch: messagesFetchTime,
                sort: sortTime,
                output: outputTime,
                total: totalTime
            }
        };

    } catch (error) {
        logTime('❌ 执行过程出错：' + error.message);
        if (error.code) {
            logTime(`错误代码: ${error.code}`);
        }
        throw error;
    } finally {
        logTime('正在断开连接...');
        await client.destroy();
        logTime('已断开连接');
    }
}

// 执行测试
console.log('开始测试...');
getAndSortActiveThreads(guildId)
    .catch(error => {
        console.error('严重错误:', error);
        process.exit(1);
    });