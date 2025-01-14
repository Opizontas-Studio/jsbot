const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { measureTime, logTime } = require('./utils/common');
const { loadCommandFiles } = require('./utils/commandLoader');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

// 加载命令
const commands = loadCommandFiles();
for (const [name, command] of commands) {
    client.commands.set(name, command);
}

// 加载事件处理器
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
    } else {
        client.on(event.name, (...args) => event.execute(...args));
    }
}

process.on('unhandledRejection', error => {
    console.error('未处理的Promise拒绝:', error);
});

// 登录
console.log('正在登录...');
const loginTimer = measureTime();

client.login(token)
    .then(() => {
        console.log(`登录完成，用时: ${loginTimer()}秒`);
    })
    .catch(error => {
        console.error('登录失败:', error);
        process.exit(1);
});