const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { REST, Routes } = require('discord.js');
const config = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { measureTime, logTime } = require('./utils/helper');
const GuildManager = require('./utils/guild_config');

//注意！项目中任何需要等待用户操作的地方，都需要使用deferReply()，否则会报错！
//注意！项目中任何报错都应该使用flags: ['Ephemeral']，否则会报错，不要使用Ephemeral = true
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
                logTime(`❌ 加载命令文件 ${file} 失败:`, true);
                console.error(error.stack);
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

// 在文件顶部添加重试相关的常量
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 10000;

// 修改 REST 客户端的配置
const rest = new REST({
    version: '10',
    timeout: 20000,
    retries: 3
}).setToken(config.token);

// 添加重试函数
async function retryOperation(operation, attempts = MAX_RETRY_ATTEMPTS) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await operation();
        } catch (error) {
            if (i === attempts - 1) throw error;
            logTime(`操作失败，${attempts - i - 1}次重试机会remaining: ${error.message}`, true);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
}

// 部署命令
async function deployCommands() {
    if (!config.token || !config.clientId) {
        throw new Error('配置文件缺少必要参数');
    }

    const deployTimer = measureTime();
    const commands = loadCommandFiles();
    const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());

    try {
        logTime('开始同步命令...');
        
        // 创建 REST 实例
        const rest = new REST({ version: '10' }).setToken(config.token);

        // 获取所有服务器ID
        const guildIds = client.guildManager.getGuildIds();
        
        for (const guildId of guildIds) {
            try {
                // 直接部署到服务器，不需要先清理
                const result = await rest.put(
                    Routes.applicationGuildCommands(config.clientId, guildId),
                    { body: commandData }
                );

                logTime(`服务器 ${guildId} 命令同步完成，共 ${result.length} 个命令`);
                
                // 添加短暂延迟避免速率限制
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                logTime(`服务器 ${guildId} 命令同步失败: ${error.message}`, true);
                if (error.code === 50001) {
                    logTime('错误原因: Bot缺少必要权限', true);
                }
            }
        }

        logTime(`命令同步完成，总用时: ${deployTimer()}秒`);
        return commands;

    } catch (error) {
        logTime(`命令同步时发生错误: ${error.message}`, true);
        throw error;
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
    process.on('unhandledRejection', (error) => {
        logTime('未处理的Promise拒绝:', true);
        console.error('错误详情:', error);
        if (error.requestBody) {
            console.error('请求数据:', error.requestBody);
        }
        if (error.response) {
            console.error('Discord API响应:', error.response);
        }
    });
    process.on('uncaughtException', (error) => {
        logTime('未捕获的异常:', true);
        console.error('错误详情:', error);
        if (error.stack) {
            console.error('堆栈跟踪:', error.stack);
        }
        process.exit(1);
    });
}

// 主函数
async function main() {
    try {
        setupProcessHandlers();

        // 初始化服务器管理器
        client.guildManager.initialize(config);

        // 先登录
        logTime('正在登录...');
        const loginTimer = measureTime();
        await client.login(config.token);
        logTime(`登录完成，用时: ${loginTimer()}秒`);

        // 加载事件
        loadEvents();

        // 等待客户端完全就绪
        if (!client.isReady()) {
            logTime('等待客户端就绪...');
            await new Promise(resolve => {
                client.once(Events.ClientReady, resolve);
            });
        }

        // 部署命令并加载到客户端
        logTime('开始部署命令...');
        const commands = await deployCommands();
        client.commands = new Collection(commands);

    } catch (error) {
        logTime(error.message, true);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

// 启动应用
main();