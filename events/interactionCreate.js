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

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            logTime(`未找到命令 ${interaction.commandName}`, true);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            logTime(`执行命令 ${interaction.commandName} 时出错: ${error}`, true);
            const message = '执行此命令时出现错误。';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: message, ephemeral: true });
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    },
}; 