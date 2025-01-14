const { REST, Routes } = require('discord.js');
const { clientId, guildId, token } = require('./config.json');
const { loadCommandFiles } = require('./utils/commandLoader');

if (!token || !clientId || !guildId) {
    console.error('错误: 配置文件缺少必要参数');
    process.exit(1);
}

const rest = new REST().setToken(token);

(async () => {
    try {
        console.log('开始部署命令...');
        
        // 清理现有命令
        await Promise.all([
            rest.put(Routes.applicationCommands(clientId), { body: [] }),
            rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] })
        ]);
        
        // 注册新命令
        const commands = Array.from(loadCommandFiles().values()).map(cmd => cmd.data.toJSON());
        const data = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands }
        );

        console.log(`\n✅ 已注册 ${data.length} 个命令:`);
        data.forEach(cmd => console.log(`- ${cmd.name}: ${cmd.description}`));

    } catch (error) {
        console.error('部署失败:', error);
        if (error.rawError) {
            console.error('详细信息:', JSON.stringify(error.rawError, null, 2));
        }
        process.exit(1);
    }
})();