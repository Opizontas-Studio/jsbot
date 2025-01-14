const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('../config.json');
const { ProxyAgent } = require('undici');

// 常量定义
const THRESHOLD = 700;  // 目标阈值
const ZOMBIE_HOURS = 72; // 僵尸贴判定时间（小时）

const proxyAgent = new ProxyAgent({
    uri: 'http://127.0.0.1:7890',
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

async function getAndSortActiveThreads(guildId) {
    // 计数器初始化
    let totalActive = 0;    // N_0
    let zombieCount = 0;    // N_1
    let huntCount = 0;      // N_2

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
        totalActive = threads.size;
        const delta = totalActive - THRESHOLD;

        logTime(`共找到 ${totalActive} 个活跃主题，差值D = ${delta}`);
        const fetchTime = Date.now() - fetchStartTime;
        logTime(`获取服务器和线程完成，耗时: ${fetchTime}ms`);

        // 获取消息计时开始
        const messagesFetchStartTime = Date.now();
        const now = Date.now();
        const threadInfoArray = await Promise.all(
            Array.from(threads.values()).map(async (thread) => {
                try {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMessage = messages.first();
                    const lastMessageTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                    const timeDiff = (now - lastMessageTime) / (1000 * 60 * 60); // 转换为小时

                    return {
                        name: thread.name,
                        lastMessageTime,
                        lastMessageAt: new Date(lastMessageTime).toLocaleString(),
                        isCreateTime: !lastMessage,
                        messageCount: thread.messageCount || 0,
                        messagePreview: lastMessage
                            ? lastMessage.content.slice(0, 10) + (lastMessage.content.length > 10 ? '...' : '')
                            : '无消息',
                        timeDiff,
                        isZombie: timeDiff >= ZOMBIE_HOURS
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
                        timeDiff: (now - thread.createdTimestamp) / (1000 * 60 * 60),
                        isZombie: false,
                        error: error.message
                    };
                }
            })
        );

        const messagesFetchTime = Date.now() - messagesFetchStartTime;
        logTime(`消息获取完成，耗时: ${messagesFetchTime}ms`);

        // 排序计时开始
        const sortStartTime = Date.now();
        threadInfoArray.sort((a, b) => b.timeDiff - a.timeDiff); // 按时间差降序排序
        const sortTime = Date.now() - sortStartTime;
        logTime(`排序完成，耗时: ${sortTime}ms`);

        // 统计计算开始
        const analysisStartTime = Date.now();

        // 计算僵尸贴
        zombieCount = threadInfoArray.filter(thread => thread.isZombie).length;

        // 计算追杀贴
        for(const thread of threadInfoArray) {
            if(thread.isZombie || huntCount < delta) {
                huntCount++;
            } else {
                break;
            }
        }

        const analysisTime = Date.now() - analysisStartTime;
        logTime(`统计分析完成，耗时: ${analysisTime}ms`);

        // 输出计时开始
        const outputStartTime = Date.now();
        logTime('\n状态统计:');
        logTime(`当前活跃贴数量(N_0): ${totalActive}`);
        logTime(`目标阈值(THRESHOLD): ${THRESHOLD}`);
        logTime(`需要归档数量(D): ${delta}`);
        logTime(`僵尸贴数量(N_1): ${zombieCount}`);
        logTime(`追杀贴数量(N_2): ${huntCount}`);

        console.log('\n排序结果:');
        threadInfoArray.forEach((thread, index) => {
            console.log(`${index + 1}. ${thread.name}`);
            console.log(`   消息数量: ${thread.messageCount}`);
            console.log(`   最后消息: ${thread.messagePreview}`);
            console.log(`   最后活跃: ${thread.lastMessageAt}`);
            console.log(`   不活跃时长: ${thread.timeDiff.toFixed(1)}小时`);
            console.log(`   状态: ${thread.isZombie ? '僵尸贴' : (index < huntCount ? '追杀名单' : '活跃')}`);
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
        logTime(`获取服务器和线程耗时: ${fetchTime}ms`);
        logTime(`获取消息耗时: ${messagesFetchTime}ms`);
        logTime(`排序耗时: ${sortTime}ms`);
        logTime(`统计分析耗时: ${analysisTime}ms`);
        logTime(`输出耗时: ${outputTime}ms`);
        logTime(`总耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`);

        return {
            threadInfoArray,
            statistics: {
                totalActive,
                zombieCount,
                huntCount,
                delta
            },
            timing: {
                login: loginTime,
                fetch: fetchTime,
                messagesFetch: messagesFetchTime,
                sort: sortTime,
                analysis: analysisTime,
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
getAndSortActiveThreads('1134557553011998840')
    .catch(error => {
        console.error('严重错误:', error);
        process.exit(1);
    });