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

async function archiveInactiveThreads(guildId) {
    let totalActive = 0;    // N_0
    let zombieCount = 0;    // N_1
    let archiveCount = 0;   // N_2
    let actualArchived = 0; // 实际归档数量

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
                    return {
                        thread,  // 保存thread对象用于后续归档
                        timeDiff,
                        isZombie: timeDiff >= ZOMBIE_HOURS
                    };
                } catch (error) {
                    const timeDiff = (now - thread.createdTimestamp) / (1000 * 60 * 60);
                    return {
                        thread,
                        timeDiff,
                        isZombie: timeDiff >= ZOMBIE_HOURS
                    };
                }
            })
        );
        const messagesFetchTime = Date.now() - messagesFetchStartTime;

        const sortStartTime = Date.now();
        threadInfoArray.sort((a, b) => b.timeDiff - a.timeDiff);
        const sortTime = Date.now() - sortStartTime;

        const analysisStartTime = Date.now();
        zombieCount = threadInfoArray.filter(thread => thread.isZombie).length;

        // 获取待归档列表
        const toArchive = [];
        for(const threadInfo of threadInfoArray) {
            if(archiveCount < delta) {
                toArchive.push(threadInfo.thread);
                archiveCount++;
            } else {
                break;
            }
        }
        const analysisTime = Date.now() - analysisStartTime;

        // 执行归档
        const archiveStartTime = Date.now();
        if(toArchive.length > 0) {
            logTime(`开始归档 ${toArchive.length} 个主题...`);

            const createArchiveTask = async (thread, index, total) => {
                try {
                    await thread.setArchived(true);
                    actualArchived++;
                } catch (error) {
                    logTime(`归档失败 ${thread.name}: ${error.message}`);
                }
            };

            const archiveTasks = toArchive.map((thread, index) => {
                // 每个任务间隔30ms启动，避免API限制
                return new Promise(resolve =>
                    setTimeout(() => {
                        createArchiveTask(thread, index, toArchive.length)
                            .then(resolve);
                    }, index * 30)
                );
            });

            await Promise.all(archiveTasks);
        }
        const archiveTime = Date.now() - archiveStartTime;

        // 输出统计数据
        logTime('\n状态统计:');
        logTime(`活跃贴总数(N_0): ${totalActive}`);
        logTime(`需归档数量(D): ${delta}`);
        logTime(`僵尸贴数量(N_1): ${zombieCount}`);
        logTime(`待归档数量(N_2): ${archiveCount}`);
        logTime(`实际归档数量: ${actualArchived}`);

        // 输出性能统计
        logTime('\n性能统计:');
        logTime(`登录耗时: ${loginTime}ms`);
        logTime(`获取数据耗时: ${fetchTime}ms`);
        logTime(`消息获取耗时: ${messagesFetchTime}ms`);
        logTime(`排序耗时: ${sortTime}ms`);
        logTime(`分析耗时: ${analysisTime}ms`);
        logTime(`归档耗时: ${archiveTime}ms`);
        logTime(`总耗时: ${Date.now() - loginStartTime}ms`);

        return {
            statistics: {
                totalActive,
                zombieCount,
                archiveCount,
                actualArchived,
                delta
            },
            timing: {
                login: loginTime,
                fetch: fetchTime,
                messagesFetch: messagesFetchTime,
                sort: sortTime,
                analysis: analysisTime,
                archive: archiveTime,
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

// 执行归档
archiveInactiveThreads('1291925535324110879')
    .catch(error => {
        console.error('严重错误:', error);
        process.exit(1);
    });