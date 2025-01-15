const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { REST, Routes } = require('discord.js');
const config = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { measureTime, logTime } = require('./utils/common');
const GuildManager = require('./utils/guildManager');

// 初始化客户端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();
client.guildManager = new GuildManager();

// 加载命令文件
function loadCommandFiles() {
    const commands = new Map();
    const commandsPath = path.join(__dirname, 'commands');
    
    fs.readdirSync(commandsPath)
        .filter(file => file.endsWith('.js'))
        .forEach(file => {
            try {
                const command = require(path.join(commandsPath, file));
                if (!command.data?.name || !command.execute) {
                    logTime(`⚠️ ${file} 缺少必要属性`);
                    return;
                }
                
                if (commands.has(command.data.name)) {
                    logTime(`⚠️ 重复命令名称 "${command.data.name}"`);
                    return;
                }

                commands.set(command.data.name, command);
            } catch (error) {
                logTime(`❌ 加载 ${file} 失败: ${error}`, true);
            }
        });
        
    logTime(`已加载 ${commands.size} 个命令: ${Array.from(commands.keys()).join(', ')}`);
    return commands;
}

// 加载事件处理器
function loadEvents() {
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    logTime(`开始加载 ${eventFiles.length} 个事件处理器`);
    for (const file of eventFiles) {
        const event = require(path.join(eventsPath, file));
        const eventHandler = (...args) => event.execute(...args);
        
        if (event.once) {
            client.once(event.name, eventHandler);
        } else {
            client.on(event.name, eventHandler);
        }
        logTime(`已加载事件: ${event.name}`);
    }
}

// 部署命令
async function deployCommands() {
    if (!config.token || !config.clientId) {
        throw new Error('配置文件缺少必要参数');
    }

    const rest = new REST({
        version: '10',
        timeout: 15000 // 设置15秒超时
    }).setToken(config.token);
    
    const commands = loadCommandFiles();
    const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());

    try {
        // 清理全局命令
        logTime('清理全局命令...');
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: [] }
        );

        // 并行处理所有服务器的命令部署
        const guildIds = client.guildManager.getGuildIds();
        const deployPromises = guildIds.map(async (guildId) => {
            try {
                const timer = measureTime();
                logTime(`开始处理服务器 ${guildId} 的命令...`);

                // 清理命令
                await rest.put(
                    Routes.applicationGuildCommands(config.clientId, guildId),
                    { body: [] }
                ).catch(error => {
                    throw new Error(`清理命令失败: ${error.message}`);
                });

                // 部署新命令
                await rest.put(
                    Routes.applicationGuildCommands(config.clientId, guildId),
                    { body: commandData }
                ).catch(error => {
                    throw new Error(`部署命令失败: ${error.message}`);
                });

                logTime(`服务器 ${guildId} 命令处理完成，用时: ${timer()}秒`);
                return true;
            } catch (error) {
                logTime(`服务器 ${guildId} 命令部署失败: ${error.message}`, true);
                return false;
            }
        });

        // 等待所有服务器的命令部署完成
        const results = await Promise.allSettled(deployPromises);
        
        // 检查部署结果
        const failedGuilds = results
            .map((result, index) => ({ result, guildId: guildIds[index] }))
            .filter(({ result }) => result.status === 'rejected' || !result.value);

        if (failedGuilds.length > 0) {
            logTime(`${failedGuilds.length} 个服务器的命令部署失败:`, true);
            failedGuilds.forEach(({ guildId }) => {
                logTime(`- 服务器 ${guildId}`, true);
            });
        }

        const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
        logTime(`命令部署完成: ${successCount}/${guildIds.length} 个服务器成功`);

        return commands;
    } catch (error) {
        throw new Error(`部署命令失败: ${error.message}`);
    }
}

// 设置进程事件处理
function setupProcessHandlers() {
    const exitHandler = (signal) => {
        logTime(`收到${signal}信号，正在关闭...`);
        client.destroy();
        process.exit(0);
    };

    const errorHandler = (error, source) => {
        logTime(`${source}: ${error.name}: ${error.message}`, true);
        if (error.stack) {
            console.error(error.stack);
        }
    };

    process.on('SIGINT', () => exitHandler('退出'));
    process.on('SIGTERM', () => exitHandler('终止'));
    process.on('unhandledRejection', (error) => errorHandler(error, '未处理的Promise拒绝'));
    process.on('uncaughtException', (error) => {
        errorHandler(error, '未捕获的异常');
        process.exit(1);
    });
}

// 主函数
async function main() {
    try {
        setupProcessHandlers();

        // 初始化服务器管理器
        client.guildManager.initialize(config);

        // 部署命令并加载到客户端
        logTime('开始部署命令...');
        const commands = await deployCommands();
        client.commands = new Collection(commands);

        // 加载事件
        loadEvents();

        // 登录
        logTime('正在登录...');
        const loginTimer = measureTime();
        await client.login(config.token);
        logTime(`登录完成，用时: ${loginTimer()}秒`);

    } catch (error) {
        logTime(error.message, true);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// 启动应用
main();