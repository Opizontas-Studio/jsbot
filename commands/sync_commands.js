const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { REST, Routes } = require('discord.js');
const { logTime, measureTime, loadCommandFiles } = require('../utils/helper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('同步指令')
        .setDescription('清除并重新同步所有Discord指令')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // 仅管理员可用

    async execute(interaction, guildConfig) {
        await interaction.deferReply({ ephemeral: true });
        
        try {
            const deployTimer = measureTime();
            const commandsPath = path.join(__dirname);
            const commands = loadCommandFiles(commandsPath, ['sync_commands.js']);
            const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());
            
            // 创建 REST 实例
            const rest = new REST({ version: '10' }).setToken(interaction.client.token);
            
            logTime('开始同步命令...');
            
            // 获取所有服务器ID
            const guildIds = interaction.client.guildManager.getGuildIds();
            
            for (const guildId of guildIds) {
                try {
                    // 先清除现有命令
                    await rest.put(
                        Routes.applicationGuildCommands(interaction.client.application.id, guildId),
                        { body: [] }
                    );
                    
                    // 部署新命令
                    const result = await rest.put(
                        Routes.applicationGuildCommands(interaction.client.application.id, guildId),
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

            // 更新客户端的commands集合
            interaction.client.commands = new Collection(commands);

            await interaction.editReply({
                content: `✅ 命令同步完成，总用时: ${deployTimer()}秒`
            });

        } catch (error) {
            await interaction.editReply({
                content: `❌ 命令同步失败: ${error.message}`
            });
            throw error;
        }
    }
}; 