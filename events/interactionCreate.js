const { Events } = require('discord.js');
const { logTime } = require('../utils/common');

/**
 * 处理Discord斜杠命令交互
 * @param {Interaction} interaction - Discord交互对象
 */
module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isChatInputCommand()) return;

        // 获取服务器特定配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig) {
            await interaction.reply({ 
                content: '此服务器尚未配置，无法使用命令。',
                flags: ['Ephemeral']
            });
            return;
        }

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            logTime(`未找到命令 ${interaction.commandName}`, true);
            return;
        }

        try {
            // 传入服务器配置
            await command.execute(interaction, guildConfig);
        } catch (error) {
            logTime(`执行命令 ${interaction.commandName} 时出错: ${error}`, true);
            const message = '执行此命令时出现错误。';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: message, flags: ['Ephemeral'] });
            } else {
                await interaction.reply({ content: message, flags: ['Ephemeral'] });
            }
        }
    },
}; 