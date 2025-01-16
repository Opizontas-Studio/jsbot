const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { REST, Routes } = require('discord.js');
const config = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { measureTime, logTime, loadCommandFiles, delay } = require('./utils/helper');
const GuildManager = require('./utils/guild_config');

//注意！项目中任何需要等待用户操作的地方，都需要使用deferReply()，否则会报错！
//注意！项目中任何报错都应该使用flags: ['Ephemeral']，否则会报错，不要使用Ephemeral = true
// 初始化客户端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.commands = new Collection();
client.guildManager = new GuildManager();

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

// 设置进程事件处理
function setupProcessHandlers() {
    const exitHandler = (signal) => {
        logTime(`收到${signal}信号，正在关闭`);
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
        const loginTimer = measureTime();
        await client.login(config.token);
        logTime(`登录完成，用时: ${loginTimer()}秒`);

        // 加载事件
        loadEvents();

        // 等待客户端完全就绪
        if (!client.isReady()) {
            await new Promise(resolve => {
                client.once(Events.ClientReady, resolve);
            });
        }

        // 检查并部署未部署命令的服务器
        const commandsPath = path.join(__dirname, 'commands');
        const commands = loadCommandFiles(commandsPath);
        const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());
        
        const rest = new REST({ version: '10' }).setToken(config.token);
        
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
                    fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
                    logTime(`服务器 ${guildId} 命令部署完成，共 ${result.length} 个命令`);

                    // 添加延迟避免速率限制
                    await delay(500);
                } catch (error) {
                    logTime(`服务器 ${guildId} 命令部署失败: ${error.message}`, true);
                    if (error.code === 50001) {
                        logTime('错误原因: Bot缺少必要权限', true);
                    }
                }
            }
        }

        // 加载命令到客户端集合中
        client.commands = new Collection(commands);

    } catch (error) {
        logTime(error.message, true);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
}

// 启动应用
main(); 