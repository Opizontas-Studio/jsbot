const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { REST, Routes } = require('discord.js');
const { token, clientId, guildId } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { measureTime, logTime } = require('./utils/common');

// 初始化客户端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

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
    if (!token || !clientId || !guildId) {
        throw new Error('配置文件缺少必要参数');
    }

    const rest = new REST().setToken(token);
    const commands = loadCommandFiles();
    // 只序列化命令数据用于API注册
    const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());

    try {
        // 清理并注册新命令
        await Promise.all([
            rest.put(Routes.applicationCommands(clientId), { body: [] }),
            rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] })
        ]);
        
        const data = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commandData }
        );

        logTime(`已注册 ${data.length} 个命令: ${data.map(cmd => cmd.name).join(', ')}`);
        // 返回原始命令对象Map，而不是序列化后的数据
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

        // 部署命令并加载到客户端
        logTime('开始部署命令...');
        const commands = await deployCommands();
        // 直接设置命令集合
        client.commands = new Collection(commands);

        // 加载事件
        loadEvents();

        // 登录
        logTime('正在登录...');
        const loginTimer = measureTime();
        await client.login(token);
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