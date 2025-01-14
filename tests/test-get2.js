const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('../config.json');
const { ProxyAgent } = require('undici');

const THRESHOLD = 900;  // 目标阈值
const ZOMBIE_HOURS = 72; // 僵尸贴判定时间（小时）

const proxyAgent = new ProxyAgent({
    uri: 'http://127.0.0.1:7890',
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

async function getThreadStatistics(guildId) {
    let totalActive = 0;    // N_0
    let zombieCount = 0;    // N_1
    let archiveCount = 0;   // N_2 (原 huntCount)

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
        const loginStartTime = Date.now();
        await new Promise((resolve) => {
            client.once(Events.ClientReady, resolve);
            client.login(token);
        });
        const loginTime = Date.now() - loginStartTime;

        const fetchStartTime = Date.now();
        const guild = await client.guilds.fetch(guildId);
        const { threads } = await guild.channels.fetchActiveThreads();
        totalActive = threads.size;
        const delta = totalActive - THRESHOLD;
        const fetchTime = Date.now() - fetchStartTime;

        const messagesFetchStartTime = Date.now();
        const now = Date.now();
        const threadInfoArray = await Promise.all(
            Array.from(threads.values()).map(async (thread) => {
                try {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const lastMessage = messages.first();
                    const lastMessageTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                    const timeDiff = (now - lastMessageTime) / (1000 * 60 * 60);
                    return { timeDiff, isZombie: timeDiff >= ZOMBIE_HOURS };
                } catch (error) {
                    const timeDiff = (now - thread.createdTimestamp) / (1000 * 60 * 60);
                    return { timeDiff, isZombie: timeDiff >= ZOMBIE_HOURS };
                }
            })
        );
        const messagesFetchTime = Date.now() - messagesFetchStartTime;

        const sortStartTime = Date.now();
        threadInfoArray.sort((a, b) => b.timeDiff - a.timeDiff);
        const sortTime = Date.now() - sortStartTime;

        const analysisStartTime = Date.now();
        // 计算僵尸贴数量
        zombieCount = threadInfoArray.filter(thread => thread.isZombie).length;

        // 简化后的归档计数逻辑
        for(const thread of threadInfoArray) {
            if(archiveCount < delta) {
                archiveCount++;
            } else {
                break;
            }
        }
        const analysisTime = Date.now() - analysisStartTime;

        // 输出关键统计数据
        logTime('\n状态统计:');
        logTime(`活跃贴总数(N_0): ${totalActive}`);
        logTime(`需归档数量(D): ${delta}`);
        logTime(`僵尸贴数量(N_1): ${zombieCount}`);
        logTime(`待归档数量(N_2): ${archiveCount}`);

        // 输出性能统计
        logTime('\n性能统计:');
        logTime(`登录耗时: ${loginTime}ms`);
        logTime(`获取数据耗时: ${fetchTime}ms`);
        logTime(`消息获取耗时: ${messagesFetchTime}ms`);
        logTime(`排序耗时: ${sortTime}ms`);
        logTime(`分析耗时: ${analysisTime}ms`);
        logTime(`总耗时: ${Date.now() - loginStartTime}ms`);

        return {
            statistics: {
                totalActive,
                zombieCount,
                archiveCount,  // 更新返回值命名
                delta
            },
            timing: {
                login: loginTime,
                fetch: fetchTime,
                messagesFetch: messagesFetchTime,
                sort: sortTime,
                analysis: analysisTime,
                total: Date.now() - loginStartTime
            }
        };

    } catch (error) {
        logTime('❌ 执行错误：' + error.message);
        throw error;
    } finally {
        await client.destroy();
    }
}

// 执行测试
getThreadStatistics('1134557553011998840')
    .catch(error => {
        console.error('严重错误:', error);
        process.exit(1);
    });
