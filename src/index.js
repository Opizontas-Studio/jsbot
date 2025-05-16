// Node.js模块
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Discord.js库
import { DiscordAPIError } from '@discordjs/rest';
import { Client, Collection, Events, GatewayIntentBits, Options, REST, Routes } from 'discord.js';

// 本地工具函数
import GuildManager from './utils/guildManager.js';
import { getVersionInfo, handleDiscordError, loadCommandFiles } from './utils/helper.js';
import { logTime } from './utils/logger.js';

// 本地功能模块
import { dbManager } from './db/dbManager.js';
import { globalTaskScheduler } from './handlers/scheduler.js';
import { delay, globalRequestQueue } from './utils/concurrency.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));

// 初始化客户端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    makeCache: Options.cacheWithLimits({
        MessageManager: {
            maxSize: 200, // 消息缓存配置
        },
    }),
    failIfNotExists: false,
});

// 初始化命令集合和GuildManager
client.commands = new Collection();
client.guildManager = new GuildManager();

// 加载事件函数
export async function loadEvents(client) {
    const eventsPath = join(currentDir, 'events');
    const eventFiles = readdirSync(eventsPath).filter(file => file.endsWith('.js'));
    let loadedEvents = 0;

    for (const file of eventFiles) {
        try {
            const eventPath = join(eventsPath, file);
            // 转换为 file:// URL
            const fileUrl = `file://${eventPath.replace(/\\/g, '/')}`;
            const event = await import(fileUrl);

            // 处理导出的单个事件或事件数组
            const eventList = Array.isArray(event.default) ? event.default : [event.default];

            for (const evt of eventList) {
                if (!evt || !evt.name || !evt.execute) {
                    logTime(`警告: ${file} 中的事件格式无效`, true);
                    continue;
                }

                if (evt.once) {
                    client.once(evt.name, (...args) => evt.execute(...args));
                } else {
                    client.on(evt.name, (...args) => evt.execute(...args));
                }
                loadedEvents++;
            }
        } catch (error) {
            logTime(`加载事件文件 ${file} 失败:`, true);
            console.error(error.stack);
        }
    }
    logTime(`已加载 ${loadedEvents} 个事件处理器`);
}

// 进程错误处理
const handleProcessError = async (error, source = '') => {
    const errorDetails = error instanceof Error ? error : new Error(String(error));
    logTime(`${source ? `[${source}] ` : ''}发生错误:`, true);
    console.error(errorDetails);

    // 统一的网络错误处理
    if (
        errorDetails.code === 'ECONNRESET' ||
        errorDetails.code === 'ETIMEDOUT' ||
        errorDetails.code === 'EPIPE' ||
        errorDetails.code === 'ENOTFOUND' ||
        errorDetails.code === 'ECONNREFUSED' ||
        errorDetails.name === 'DiscordAPIError' ||
        errorDetails.name === 'HTTPError' ||
        errorDetails.name === 'WebSocketError'
    ) {
        logTime('检测到网络错误，强制清理队列...', true);
        // 直接清理，不等待结果
        globalRequestQueue.cleanup().catch(() => null);
    }
};

// 命令部署函数
const deployCommands = async (client, commands, config) => {
    const rest = new REST({ version: '10' }).setToken(config.token);
    const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());
    let configUpdated = false;

    await Promise.all(
        Object.entries(config.guilds).map(async ([guildId, guildConfig]) => {
            if (guildConfig.commandsDeployed) return;

            try {
                logTime(`正在为服务器 ${guildId} 部署命令`);
                const result = await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), {
                    body: commandData,
                });

                config.guilds[guildId].commandsDeployed = true;
                configUpdated = true;
                logTime(`服务器 ${guildId} 命令部署完成，共 ${result.length} 个命令`);
                await delay(500); // 避免速率限制
            } catch (error) {
                const errorMessage = error instanceof DiscordAPIError ? handleDiscordError(error) : error.message;
                logTime(`服务器 ${guildId} 命令部署失败: ${errorMessage}`, true);
            }
        }),
    );

    if (configUpdated) {
        writeFileSync('./config.json', JSON.stringify(config, null, 4));
    }
};

// 优雅关闭函数
const gracefulShutdown = async (client, signal) => {
    logTime(`收到${signal}信号，正在关闭`);

    try {
        // 停止所有定时任务
        if (globalTaskScheduler) {
            globalTaskScheduler.stopAll();
        }

        // 清理请求队列
        if (globalRequestQueue) {
            await globalRequestQueue.cleanup();
        }

        // 关闭数据库连接
        if (dbManager && dbManager.getConnectionStatus()) {
            // 在关闭前执行一次备份
            try {
                await dbManager.backup();
            } catch (error) {
                logTime('关闭前备份失败: ' + error.message, true);
            }

            await dbManager.disconnect();
        }

        // 等待一小段时间
        await delay(1000);

        // 移除所有事件监听器并销毁客户端连接
        if (client.isReady()) {
            // 先移除所有事件监听器，避免断开连接事件触发重连尝试
            client.removeAllListeners();
            // 清理WebSocket监控器的定时器
            if (client.wsStateMonitor && client.wsStateMonitor.heartbeatInterval) {
                clearInterval(client.wsStateMonitor.heartbeatInterval);
            }
            await client.destroy();
        }
        process.exit(0);
    } catch (error) {
        logTime('退出过程中发生错误:', true);
        console.error(error);
        process.exit(1);
    }
};

// 进程事件处理
const setupProcessHandlers = client => {
    process.on('uncaughtException', error => handleProcessError(error, 'uncaughtException'));
    process.on('unhandledRejection', (reason, promise) => handleProcessError(reason, 'unhandledRejection'));
    process.on('SIGINT', () => gracefulShutdown(client, '退出'));
    process.on('SIGTERM', () => gracefulShutdown(client, '终止'));
};

// 主函数
async function main() {
    try {
        // 版本信息
        const versionInfo = getVersionInfo();
        if (versionInfo) {
            logTime(`GateKeeper in Odysseia ${versionInfo.version} (${versionInfo.commitHash})`);
            logTime(`提交时间: ${versionInfo.commitDate}`);
        }

        // 初始化进程事件调度器
        setupProcessHandlers(client);

        // 初始化数据库连接
        try {
            await dbManager.connect();
        } catch (error) {
            logTime('数据库初始化失败，无法继续运行:', true);
            console.error('错误详情:', error);
            if (error.details) {
                console.error('额外信息:', error.details);
            }
            process.exit(1);
        }

        // 初始化配置管理器
        client.guildManager.initialize(config);

        // 登录
        try {
            await client.login(config.token);
        } catch (error) {
            logTime(`登录失败: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error.message}`, true);
            process.exit(1);
        }

        // 加载事件
        await loadEvents(client);

        // 等待客户端完全就绪
        if (!client.isReady()) {
            await new Promise(resolve => {
                client.once(Events.ClientReady, resolve);
            });
        }

        // 加载命令
        const commandsPath = join(currentDir, 'commands');
        const commands = await loadCommandFiles(commandsPath);

        // 部署命令
        await deployCommands(client, commands, config);

        // 加载命令到客户端集合中
        client.commands = new Collection(commands);
    } catch (error) {
        logTime('启动过程中发生错误:', true);
        console.error(error);

        // 发生错误时也正确断开数据库
        if (dbManager && dbManager.getConnectionStatus()) {
            await dbManager.disconnect();
        }

        process.exit(1);
    }
}

// 万剑归宗
main();
