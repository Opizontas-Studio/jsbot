const { Client, Events, GatewayIntentBits } = require('discord.js');
const { token, guildId, logThreadId, threshold, zombieHours, proxyUrl, pinnedThreads, diagnosticMode } = require('./config.json');
const { ProxyAgent } = require('undici');
const { DiscordAPIError } = require('@discordjs/rest');

// 创建代理实例，用于处理网络请求
const proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

// 创建Discord客户端实例
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    rest: {
        timeout: 20000,
        retries: 3,
        agent: proxyAgent
    }
});

// 增强的日志处理类，含诊断模式和消息缓冲
class Logger {
    constructor(logThread) {
        this.logThread = logThread;
        this.messages = [];
        this.diagnosticMessages = [];
    }

    log(message) {
        const timestamp = new Date().toLocaleString();
        console.log(`[${timestamp}] ${message}`);
        this.messages.push(message);
    }

    diagnostic(message) {
        if (diagnosticMode) {
            const timestamp = new Date().toLocaleString();
            console.log(`[DIAGNOSTIC][${timestamp}] ${message}`);
            this.diagnosticMessages.push(`[DIAGNOSTIC] ${message}`);
        }
    }

    async flush(forceSend = false) {
        let allMessages = [...this.messages];
        if (diagnosticMode) {
            allMessages = allMessages.concat(this.diagnosticMessages);
        }

        if ((allMessages.length === 0 && !forceSend) || !this.logThread) return;

        try {
            if (allMessages.length > 0) {
                // 分块发送消息，防止超过Discord消息长度限制
                const chunkSize = 1900; // 预留一些空间给代码块格式
                for (let i = 0; i < allMessages.length; i += chunkSize) {
                    const chunk = allMessages.slice(i, i + chunkSize).join('\n');
                    await this.logThread.send({
                        content: `\`\`\`\n${chunk}\n\`\`\``
                    });
                }
            }
        } catch (error) {
            console.error('发送日志到Discord失败:', error);
        }

        this.messages = [];
        this.diagnosticMessages = [];
    }
}

// 并发请求管理器，用于控制API请求并发和优雅关闭
class RequestManager {
    constructor() {
        this.activeRequests = 0;
        this.requestQueue = [];
        this.isShuttingDown = false;
    }

    async track(promise) {
        this.activeRequests++;
        try {
            return await promise;
        } finally {
            this.activeRequests--;
            if (this.isShuttingDown && this.activeRequests === 0) {
                while (this.requestQueue.length > 0) {
                    const resolve = this.requestQueue.shift();
                    resolve();
                }
            }
        }
    }

    async waitForCompletion() {
        if (this.activeRequests === 0) return;
        return new Promise(resolve => this.requestQueue.push(resolve));
    }
}

// 主要的归档处理函数
async function archiveInactiveThreads(logger) {
    const requestManager = new RequestManager();
    let statistics = {
        totalActive: 0,
        zombieCount: 0,
        archiveCount: 0,
        actualArchived: 0,
        delta: 0,
        timing: {
            fetchTime: 0,      // 获取服务器和线程列表耗时
            scanTime: 0,       // 扫描所有线程获取最后消息耗时
            sortTime: 0,       // 排序耗时
            archiveTime: 0,    // 归档操作耗时
            totalTime: 0       // 总耗时
        }
    };

    const startTotal = Date.now();

    try {
        logger.diagnostic('开始获取服务器信息...');
        const fetchStart = Date.now();
        const guild = await client.guilds.fetch(guildId);
        const { threads } = await guild.channels.fetchActiveThreads();
        statistics.timing.fetchTime = Date.now() - fetchStart;
        logger.diagnostic(`获取到 ${threads.size} 个活跃帖子，耗时 ${statistics.timing.fetchTime}ms`);

        // 过滤置顶贴
        const pinnedThreadIds = Object.values(pinnedThreads);
        logger.diagnostic(`开始过滤 ${pinnedThreadIds.length} 个置顶帖...`);
        const activeThreads = Array.from(threads.values())
            .filter(thread => !pinnedThreadIds.includes(thread.id));

        statistics.totalActive = activeThreads.length;
        statistics.delta = statistics.totalActive - threshold;

        logger.diagnostic(`过滤后剩余 ${statistics.totalActive} 个活跃帖子`);
        logger.diagnostic(`当前超出阈值 ${statistics.delta} 个帖子`);

        if (statistics.delta <= 0) {
            logger.diagnostic('活跃帖子数量未超过阈值，无需清理');
            statistics.timing.totalTime = Date.now() - startTotal;
            return statistics;
        }

        // 扫描线程最后活动时间
        logger.diagnostic('开始获取所有线程的最后活动时间...');
        const scanStart = Date.now();
        const threadInfoArray = await Promise.all(
            activeThreads.map(async thread => {
                return await requestManager.track(async () => {
                    try {
                        const messages = await thread.messages.fetch({ limit: 1 });
                        const lastMessage = messages.first();
                        const lastMessageTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                        const timeDiff = (Date.now() - lastMessageTime) / (1000 * 60 * 60);
                        return {
                            thread,
                            timeDiff,
                            isZombie: timeDiff >= zombieHours
                        };
                    } catch (error) {
                        const timeDiff = (Date.now() - thread.createdTimestamp) / (1000 * 60 * 60);
                        return {
                            thread,
                            timeDiff,
                            isZombie: timeDiff >= zombieHours
                        };
                    }
                });
            })
        );
        statistics.timing.scanTime = Date.now() - scanStart;
        logger.diagnostic(`线程扫描完成，耗时 ${statistics.timing.scanTime}ms`);

        // 排序及分析
        const sortStart = Date.now();
        threadInfoArray.sort((a, b) => b.timeDiff - a.timeDiff);
        statistics.timing.sortTime = Date.now() - sortStart;
        statistics.zombieCount = threadInfoArray.filter(thread => thread.isZombie).length;
        logger.diagnostic(`排序完成，耗时 ${statistics.timing.sortTime}ms，发现 ${statistics.zombieCount} 个僵尸帖子`);

        // 归档操作
        const archiveStart = Date.now();
        const toArchive = threadInfoArray
            .slice(0, statistics.delta)
            .map(info => info.thread);

        statistics.archiveCount = toArchive.length;

        if (toArchive.length > 0) {
            logger.log(`需要归档 ${toArchive.length} 个主题`);
            logger.diagnostic('开始执行归档操作...');

            // 创建归档任务
            const createArchiveTask = async (thread) => {
                return await requestManager.track(async () => {
                    try {
                        await thread.setArchived(true);
                        statistics.actualArchived++;
                        logger.diagnostic(`成功归档: ${thread.name}`);
                    } catch (error) {
                        if (error instanceof DiscordAPIError) {
                            switch (error.code) {
                                case 429: // Rate limit
                                    logger.log(`触发限流 - ${thread.name}: 等待 ${error.retry_after}秒`);
                                    await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
                                    try {
                                        await thread.setArchived(true);
                                        statistics.actualArchived++;
                                        logger.diagnostic(`重试成功: ${thread.name}`);
                                    } catch (retryError) {
                                        logger.log(`重试失败 - ${thread.name}: ${retryError.message}`);
                                    }
                                    break;
                                case 403:
                                    logger.log(`权限错误 - ${thread.name}`);
                                    break;
                                case 404:
                                    logger.log(`找不到目标 - ${thread.name}`);
                                    break;
                                default:
                                    logger.log(`Discord API错误 - ${thread.name}: [${error.code}] ${error.message}`);
                            }
                        } else {
                            logger.log(`未知错误 - ${thread.name}: ${error.message}`);
                        }
                    }
                });
            };

            // 并发执行归档任务，控制请求频率
            const archiveTasks = toArchive.map((thread, index) => {
                return new Promise(resolve =>
                    setTimeout(() => {
                        createArchiveTask(thread).then(resolve);
                    }, index * 30)  // 每30ms启动一个新任务
                );
            });

            await Promise.all(archiveTasks);
            statistics.timing.archiveTime = Date.now() - archiveStart;
            logger.diagnostic(`归档操作完成，耗时 ${statistics.timing.archiveTime}ms`);
        }

        statistics.timing.totalTime = Date.now() - startTotal;
        return statistics;

    } catch (error) {
        logger.log(`执行错误: ${error.message}`);
        throw error;
    } finally {
        requestManager.isShuttingDown = true;
        await requestManager.waitForCompletion();
    }
}

// 主程序入口
async function main() {
    try {
        // 等待客户端就绪
        const loginStart = Date.now();
        await new Promise((resolve) => {
            client.once(Events.ClientReady, () => {
                console.log(`以 ${client.user.tag} 身份登录成功`);
                resolve();
            });
            client.login(token);
        });
        const loginTime = Date.now() - loginStart;

        // 获取日志输出线程
        const guild = await client.guilds.fetch(guildId);
        const logThread = await client.channels.fetch(logThreadId);
        const logger = new Logger(logThread);

        // 发送启动通知
        await logThread.send({
            content: `🤖 Thread Archive Bot 已启动\n\`\`\`\n登录耗时: ${loginTime}ms\n诊断模式: ${diagnosticMode ? '开启' : '关闭'}\n阈值设定: ${threshold}\n僵尸帖时间: ${zombieHours}小时\n\`\`\``
        });

        // 定义清理任务
        const cleanup = async () => {
            try {
                logger.diagnostic('开始执行定期清理任务');
                const stats = await archiveInactiveThreads(logger);

                if (diagnosticMode || stats.actualArchived > 0) {
                    logger.log('\n状态统计:');
                    logger.log(`活跃贴总数: ${stats.totalActive}`);
                    logger.log(`超过阈值数: ${stats.delta}`);
                    logger.log(`僵尸贴数量: ${stats.zombieCount}`);
                    logger.log(`计划归档数: ${stats.archiveCount}`);
                    logger.log(`实际归档数: ${stats.actualArchived}`);

                    logger.log('\n性能统计:');
                    logger.log(`获取数据耗时: ${stats.timing.fetchTime}ms`);
                    logger.log(`扫描耗时: ${stats.timing.scanTime}ms`);
                    logger.log(`排序耗时: ${stats.timing.sortTime}ms`);
                    logger.log(`归档耗时: ${stats.timing.archiveTime}ms`);
                    logger.log(`总耗时: ${stats.timing.totalTime}ms`);
                }

                await logger.flush(diagnosticMode);

            } catch (error) {
                console.error('清理任务失败:', error);
                logger.log(`清理任务失败: ${error.message}`);
                await logger.flush(true);
            }
        };

        // 立即执行一次清理
        await cleanup();
        logger.diagnostic('首次清理任务完成');

        // 设置定时任务，每15分钟执行一次
        const interval = setInterval(cleanup, 15 * 60 * 1000);

        // 处理程序关闭
        const handleShutdown = async () => {
            clearInterval(interval);
            await logThread.send('🔄 Bot服务正在关闭...');
            await client.destroy();
            process.exit(0);
        };

        // 注册进程信号处理器
        process.on('SIGINT', handleShutdown);
        process.on('SIGTERM', handleShutdown);

        // 处理未捕获的异常
        process.on('uncaughtException', async (error) => {
            console.error('未捕获的异常:', error);
            try {
                await logThread.send({
                    content: `❌ 发生未捕获的异常:\n\`\`\`\n${error.stack}\n\`\`\``
                });
            } finally {
                process.exit(1);
            }
        });

        process.on('unhandledRejection', async (reason, promise) => {
            console.error('未处理的Promise拒绝:', reason);
            try {
                await logThread.send({
                    content: `⚠️ 发生未处理的Promise拒绝:\n\`\`\`\n${reason}\n\`\`\``
                });
            } catch (error) {
                console.error('发送错误日志失败:', error);
            }
        });

    } catch (error) {
        console.error('程序启动失败:', error);
        process.exit(1);
    }
}

// 启动程序
main().catch(error => {
    console.error('严重错误:', error);
    process.exit(1);
});