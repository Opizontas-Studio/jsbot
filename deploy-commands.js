const { REST, Routes } = require('discord.js');
const { clientId, guildId, token } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');

// 验证必要的配置
if (!token || !clientId || !guildId) {
    console.error('错误: 配置文件中缺少必要的参数 (token, clientId, guildId)');
    process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        commands.push(command.data.toJSON());
    } else {
        console.log(`[警告] 命令文件 ${filePath} 缺少必要的 "data" 或 "execute" 属性`);
    }
}

const rest = new REST().setToken(token);

(async () => {
    try {
        console.log(`开始注册 ${commands.length} 个应用命令。`);

        const data = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands },
        );

        console.log(`成功注册 ${data.length} 个应用命令。`);
    } catch (error) {
        console.error('注册命令时发生错误:', error);
        process.exit(1);
    }
})();