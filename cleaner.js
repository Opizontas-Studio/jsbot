// 导入必要的Discord.js组件
const { Client, Events, GatewayIntentBits } = require('discord.js');
// 从配置文件导入设置
const { token, guildId, logThreadId, threshold, zombieHours, proxyUrl, pinnedThreads, diagnosticMode } = require('./config.json');
// 导入网络代理工具
const { ProxyAgent } = require('undici');
// 导入Discord API错误类型
const { DiscordAPIError } = require('@discordjs/rest');

// 创建代理实例，用于处理网络请求
// 设置较长的超时时间和SSL验证选项
const proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    connect: {
        timeout: 20000,
        rejectUnauthorized: false
    }
});

// 创建Discord客户端实例
// 配置必要的权限意图和REST选项
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    rest: {
        timeout: 20000,
        retries: 3,
        agent: proxyAgent
    }
});

/**
 * 增强的日志处理类
 * 支持普通日志和诊断日志的管理，并提供批量发送功能
 */
class Logger {
    constructor(logThread) {
        this.logThread = logThread;
        this.messages = [];
        this.diagnosticMessages = [];
    }

    // 生成统一格式的时间戳
    #getTimestamp() {
        return new Date().toLocaleString();
    }

    // 记录普通日志
    log(message) {
        const timestamp = this.#getTimestamp();
        console.log(`[${timestamp}] ${message}`);
        this.messages.push(message);
    }

    // 记录诊断日志（仅在诊断模式下）
    diagnostic(message) {
        if (diagnosticMode) {
            const timestamp = this.#getTimestamp();
            console.log(`[DIAGNOSTIC][${timestamp}] ${message}`);
            this.diagnosticMessages.push(`[DIAGNOSTIC] ${message}`);
        }
    }

    // 将缓存的日志发送到Discord
    async flush(forceSend = false) {
        let allMessages = [...this.messages];
        if (diagnosticMode) {
            allMessages = allMessages.concat(this.diagnosticMessages);
        }

        if ((allMessages.length === 0 && !forceSend) || !this.logThread) return;

        try {
            if (allMessages.length > 0) {
                // 将消息分块发送，以避免超过Discord的消息长度限制
                const chunkSize = 1900; // 预留空间给代码块格式
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

        // 清空缓存
        this.messages = [];
        this.diagnosticMessages = [];
    }
}

/**
 * 请求管理器
 * 用于追踪并管理异步请求的执行状态
 */
class RequestManager {
    constructor() {
        this.activeRequests = 0;
    }

    // 追踪异步请求的执行
    async track(promise) {
        this.activeRequests++;
        try {
            return await promise;
        } finally {
            this.activeRequests--;
        }
    }

    // 检查是否所有请求都已完成
    isComplete() {
        return this.activeRequests === 0;
    }
}

/**
 * 主要的归档处理函数
 * @param {Logger} logger - 日志记录器实例
 * @returns {Promise<Statistics>} 返回处理统计信息
 */
async function archiveInactiveThreads(logger) {
    const requestManager = new RequestManager();
    let statistics = {
        totalActive: 0,
        zombieCount: 0,
        archiveCount: 0,
        actualArchived: 0,
        timing: {
            fetchTime: 0,
            archiveTime: 0,
            totalTime: 0
        }
    };

    const startTotal = Date.now();

    try {
        logger.diagnostic('开始获取服务器信息...');
        const fetchStart = Date.now();

        // 获取服务器和活跃线程信息
        const guild = await client.guilds.fetch(guildId);
        const { threads } = await guild.channels.fetchActiveThreads();
        statistics.timing.fetchTime = Date.now() - fetchStart;
        logger.diagnostic(`获取到 ${threads.size} 个活跃线程，耗时 ${statistics.timing.fetchTime}ms`);

        statistics.totalActive = threads.size;

        // 收集线程信息
        const threadInfoArray = [];
        let processedCount = 0;
        const totalThreads = threads.size;

        for (const thread of threads.values()) {
            try {
                // 添加进度日志
                processedCount++;
                if (processedCount % 100 === 0) {
                    logger.diagnostic(`正在处理线程 ${processedCount}/${totalThreads}`);
                }

                // 设置消息获取的超时
                const messagePromise = thread.messages.fetch({ limit: 1 })
                    .catch(error => {
                        logger.diagnostic(`获取消息失败 (${thread.name}): ${error.message}`);
                        return null;
                    });

                // 添加5秒超时
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('获取消息超时')), 5000));

                // 使用 Promise.race 来实现超时机制
                const messages = await Promise.race([messagePromise, timeoutPromise])
                    .catch(error => {
                        logger.diagnostic(`线程 ${thread.name} 处理超时或错误: ${error.message}`);
                        return null;
                    });

                const lastMessage = messages?.first();
                const lastMessageTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                const timeDiff = (Date.now() - lastMessageTime) / (1000 * 60 * 60);

                threadInfoArray.push({
                    thread,
                    timeDiff,
                    isZombie: timeDiff >= zombieHours,
                    isPinned: thread.id in pinnedThreads
                });
            } catch (error) {
                logger.diagnostic(`处理线程 ${thread.name} 时出错: ${error.message}`);
                const timeDiff = (Date.now() - thread.createdTimestamp) / (1000 * 60 * 60);
                threadInfoArray.push({
                    thread,
                    timeDiff,
                    isZombie: timeDiff >= zombieHours,
                    isPinned: thread.id in pinnedThreads
                });
            }

            // 每处理10个线程暂停100ms，避免API限制
            if (processedCount % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        logger.diagnostic(`完成线程信息收集，共处理 ${processedCount} 个线程`);

        // 计算僵尸线程数量
        statistics.zombieCount = threadInfoArray.filter(info => info.isZombie).length;
        logger.diagnostic(`扫描完成，发现 ${statistics.zombieCount} 个僵尸线程`);

        // 过滤和排序需要处理的线程
        const activeThreadsInfo = threadInfoArray
            .filter(info => !info.isPinned)
            .sort((a, b) => b.timeDiff - a.timeDiff);

        const excessThreads = activeThreadsInfo.length - threshold;

        if (excessThreads <= 0) {
            logger.diagnostic('活跃线程数量未超过阈值，无需清理');
            statistics.timing.totalTime = Date.now() - startTotal;
            return statistics;
        }

        // 选择需要归档的线程
        const toArchive = activeThreadsInfo.slice(0, excessThreads);
        statistics.archiveCount = toArchive.length;

        if (toArchive.length > 0) {
            logger.log(`需要归档 ${toArchive.length} 个主题`);
            logger.diagnostic('开始执行归档操作...');

            const archiveStart = Date.now();

            // 逐个处理归档
            for (const threadInfo of toArchive) {
                const thread = threadInfo.thread;
                try {
                    await thread.setArchived(true);
                    statistics.actualArchived++;
                    logger.diagnostic(`成功归档: ${thread.name} (已归档 ${statistics.actualArchived}/${toArchive.length})`);
                    // 添加延迟以避免请求过于频繁
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    if (error instanceof DiscordAPIError) {
                        switch (error.code) {
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
            }

            statistics.timing.archiveTime = Date.now() - archiveStart;
            logger.diagnostic(`归档操作完成，耗时 ${statistics.timing.archiveTime}ms`);
        }

        statistics.timing.totalTime = Date.now() - startTotal;
        return statistics;

    } catch (error) {
        logger.log(`执行错误: ${error.message}`);
        throw error;
    }
}

/**
 * 程序主入口
 * 负责初始化客户端、设置定时任务和错误处理
 */
async function main() {
    try {
        // 等待Discord客户端就绪
        const loginStart = Date.now();
        await new Promise((resolve) => {
            client.once(Events.ClientReady, () => {
                console.log(`以 ${client.user.tag} 身份登录成功`);
                resolve();
            });
            client.login(token);
        });
        const loginTime = Date.now() - loginStart;

        // 初始化日志系统
        const guild = await client.guilds.fetch(guildId);
        const logThread = await client.channels.fetch(logThreadId);
        const logger = new Logger(logThread);

        // 发送启动通知
        await logThread.send({
            content: `\`\`\`\n登录耗时: ${loginTime}ms\n诊断模式: ${diagnosticMode ? '开启' : '关闭'}\n阈值设定: ${threshold}\n当前激活间隔：30min\n终于可以睡觉了！\n\`\`\``
        });

        // 定义清理任务
        const cleanup = async () => {
            try {
                logger.diagnostic('开始执行定期清理任务');
                const stats = await archiveInactiveThreads(logger);

                if (diagnosticMode || stats.actualArchived > 0) {
                    logger.log('\n状态统计:');
                    logger.log(`活跃贴总数: ${stats.totalActive}`);
                    logger.log(`僵尸贴数量: ${stats.zombieCount}`);
                    logger.log(`计划归档数: ${stats.archiveCount}`);
                    logger.log(`实际归档数: ${stats.actualArchived}`);

                    logger.log('\n性能统计:');
                    logger.log(`获取数据耗时: ${stats.timing.fetchTime}ms`);
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

        // 立即执行首次清理
        await cleanup();
        logger.diagnostic('首次清理任务完成');

        // 设置定时清理任务（每30分钟执行一次）
        const interval = setInterval(cleanup, 30 * 60 * 1000);

        // 处理程序关闭的函数
        const handleShutdown = async () => {
            clearInterval(interval);
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

        // 处理未处理的Promise拒绝
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