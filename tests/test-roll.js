const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('../config.json');
const { ProxyAgent } = require('undici');

const proxyAgent = new ProxyAgent({
    uri: 'http://127.0.0.1:7890',
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

async function testRateLimitedArchive(guildId, count = 5) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages
        ],
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

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // 等待ready事件完成
        logTime('正在通过代理连接Discord...');
        await new Promise((resolve) => {
            client.once(Events.ClientReady, async (readyClient) => {
                logTime(`Bot准备就绪，已登录为 ${readyClient.user.tag}`);
                resolve();
            });
            client.login(token);
        });

        // 获取指定的服务器
        logTime('正在获取服务器信息...');
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            throw new Error(`找不到服务器 ${guildId}`);
        }
        logTime(`已找到服务器: ${guild.name}`);

        // 直接获取活跃threads
        logTime('正在获取活跃主题列表...');
        const { threads } = await guild.channels.fetchActiveThreads();

        // 转换为数组并限制数量
        const testThreads = Array.from(threads.values()).slice(0, count);
        logTime(`找到 ${threads.size} 个活跃主题，将处理其中 ${testThreads.length} 个`);

        // 输出要处理的threads信息
        testThreads.forEach((thread, index) => {
            logTime(`[${index + 1}/${testThreads.length}] 待处理主题: ${thread.name} (${thread.id})`);
        });

        if (testThreads.length === 0) {
            logTime('没有找到需要归档的主题');
            return;
        }

        // 创建归档任务队列
        const createArchiveTask = async (thread, index, total) => {
            const startTime = Date.now();
            try {
                logTime(`[${index + 1}/${total}] 开始归档主题: ${thread.name}`);
                await thread.setArchived(true);
                const elapsed = Date.now() - startTime;
                logTime(`归档成功 ${thread.name}，耗时: ${elapsed}ms`);
            } catch (error) {
                logTime(`❌ 归档失败 ${thread.name} (${thread.id}): ${error.message}`);
                if (error.code) {
                    logTime(`错误代码: ${error.code}`);
                }
            }
        };

        // 使用Promise.all并行执行归档任务
        const archiveTasks = testThreads.map((thread, index) => {
            // 为每个任务添加延迟，确保不会同时发起太多请求
            const delay = index * 30; // 每个任务间隔30ms启动
            return new Promise(resolve =>
                setTimeout(() => {
                    createArchiveTask(thread, index, testThreads.length)
                        .then(resolve);
                }, delay)
            );
        });

        logTime(`开始并行归档 ${testThreads.length} 个主题...`);
        await Promise.all(archiveTasks);
        logTime('所有归档任务已完成');

    } catch (error) {
        logTime('❌ 测试过程出错：' + error.message);
        if (error.code) {
            logTime(`错误代码: ${error.code}`);
        }
        logTime(`代理状态: ${proxyAgent.uri}`);
    } finally {
        logTime('正在断开连接...');
        await client.destroy();
        logTime('测试结束，已断开连接');
    }
}

// 使用示例
console.log('准备开始批量归档测试...');
testRateLimitedArchive('1291925535324110879', 5)
    .catch(error => {
        console.error('严重错误:', error);
        console.error('代理设置:', proxyAgent.uri);
        process.exit(1);
    });