const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');

// 验证token
if (!token) {
    console.error('错误: 配置文件中缺少token');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

// 加载命令
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            console.log(`已加载命令: ${command.data.name}`);
        } else {
            console.log(`[警告] 命令 ${filePath} 缺少必要的 "data" 或 "execute" 属性`);
        }
    } catch (error) {
        console.error(`[错误] 加载命令 ${filePath} 时出错:`, error);
    }
}

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
        console.error(`未找到命令 ${interaction.commandName}`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`执行命令 ${interaction.commandName} 时出错:`, error);
        const message = '执行此命令时出现错误。';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: message, ephemeral: true });
        } else {
            await interaction.reply({ content: message, ephemeral: true });
        }
    }
});

client.once(Events.ClientReady, c => {
    console.log(`准备就绪! 已登录为 ${c.user.tag}`);
});

process.on('unhandledRejection', error => {
    console.error('未处理的Promise拒绝:', error);
});

client.login(token).catch(error => {
    console.error('登录失败:', error);
    process.exit(1);
});