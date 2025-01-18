// Node.js模块
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Discord.js库
import { Client, Collection, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { DiscordAPIError } from '@discordjs/rest';

// 本地工具函数
import { measureTime, loadCommandFiles, delay, handleDiscordError, getVersionInfo } from './utils/helper.js';
import { logTime } from './utils/logger.js';
import GuildManager from './utils/guild_config.js';

// 本地功能模块
import { globalTaskScheduler } from './tasks/scheduler.js';
import { globalRequestQueue } from './utils/concurrency.js';
import { dbManager } from './db/db.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(currentDir, 'config.json'), 'utf8'));

// 初始化客户端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    // 分片配置
    shards: [0],  // 使用单分片
    failIfNotExists: false,
    // 重连配置
    presence: {
        status: 'online'
    },
    // 重连策略
    restWsBridgeTimeout: 10000,
    restTimeOffset: 750,
    restRequestTimeout: 15000,
    retryLimit: 5,
    waitGuildTimeout: 15000
});

// 监控速率限制和API响应
client.rest
    .on('rateLimited', (rateLimitData) => {
        logTime(`速率超限: • 路由: ${rateLimitData.route} - 方法: ${rateLimitData.method} - 剩余: ${rateLimitData.timeToReset}ms - 全局: ${rateLimitData.global ? '是' : '否'} - 限制: ${rateLimitData.limit || '未知'}`, true);
    })
    .on('response', (request, response) => {
        if (response.status === 429) {  // 429是速率限制状态码
            logTime(`API受限: • 路由: ${request.route} - 方法: ${request.method} - 状态: ${response.status} - 重试延迟: ${response.headers.get('retry-after')}ms`, true);
        }
    });

// 初始化命令集合和GuildManager
client.commands = new Collection();
client.guildManager = new GuildManager();

// 加载事件处理器
async function loadEvents() {
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

// 设置进程事件处理
function setupProcessHandlers() {
    // 优雅关闭处理函数
    const gracefulShutdown = async (signal) => {
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
            
            // 等待一小段时间确保任务正确停止
            await delay(500);
            
            // 销毁客户端连接
            if (client.isReady()) {
                await client.destroy();
            }
            
            logTime('所有资源已清理完毕，正在退出');
            process.exit(0);
        } catch (error) {
            logTime('退出过程中发生错误:', true);
            console.error(error);
            process.exit(1);
        }
    };

    // 进程信号处理
    process.on('SIGINT', () => gracefulShutdown('退出'));
    process.on('SIGTERM', () => gracefulShutdown('终止'));
}

// 主函数
async function main() {
    try {
        // 在开始时记录版本信息
        const versionInfo = getVersionInfo();
        if (versionInfo) {
            logTime(`GateKeeper in Odysseia ${versionInfo.version} (${versionInfo.commitHash})`);
            logTime(`提交时间: ${versionInfo.commitDate}`);
        }

        setupProcessHandlers();

        // 初始化数据库连接
        try {
            await dbManager.connect();
            logTime('数据库连接已建立');
        } catch (error) {
            logTime('数据库初始化失败，无法继续运行:', true);
            console.error('错误详情:', error);
            if (error.details) {
                console.error('额外信息:', error.details);
            }
            process.exit(1);
        }

        // 初始化服务器管理器
        client.guildManager.initialize(config);

        // 先登录
        const loginTimer = measureTime();
        try {
            await client.login(config.token);
            logTime(`登录完成，用时: ${loginTimer()}秒`);
        } catch (error) {
            logTime(`登录失败: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error.message}`, true);
            process.exit(1);
        }

        // 加载事件
        await loadEvents();

        // 等待客户端完全就绪
        if (!client.isReady()) {
            await new Promise(resolve => {
                client.once(Events.ClientReady, resolve);
            });
        }

        // 加载命令
        const commandsPath = join(currentDir, 'commands');
        const commands = await loadCommandFiles(commandsPath);
        const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());
        const rest = new REST({ version: '10' }).setToken(config.token);

        // 部署命令
        for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
            if (!guildConfig.commandsDeployed) {
                try {
                    logTime(`正在为服务器 ${guildId} 部署命令`);
                    const result = await rest.put(
                        Routes.applicationGuildCommands(client.application.id, guildId),
                        { body: commandData }
                    );
                    
                    // 更新配置文件
                    config.guilds[guildId].commandsDeployed = true;
                    writeFileSync('./config.json', JSON.stringify(config, null, 4));
                    logTime(`服务器 ${guildId} 命令部署完成，共 ${result.length} 个命令`);

                    // 添加延迟避免速率限制
                    await delay(500);
                } catch (error) {
                    const errorMessage = error instanceof DiscordAPIError ? handleDiscordError(error) : error.message;
                    logTime(`服务器 ${guildId} 命令部署失败: ${errorMessage}`, true);
                    if (error.code === 50001) {
                        logTime('错误原因: Bot缺少必要权限', true);
                    }
                }
            }
        }

        // 加载命令到客户端集合中
        client.commands = new Collection(commands);

    } catch (error) {
        logTime('启动过程中发生错误:', true);
        console.error(error);
        
        // 确保在发生错误时也能正确清理资源
        if (dbManager && dbManager.getConnectionStatus()) {
            await dbManager.disconnect();
        }
        
        process.exit(1);
    }
}

// 万剑归宗
main(); 