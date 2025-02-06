import { SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../utils/helper.js';
import { assertIsError } from '../utils/assertion.js';

export default {
    // 设置命令冷却时间为 10 秒
    cooldown: 10,

    // 定义命令
    data: new SlashCommandBuilder()
        .setName('帮助')
        .setDescription('获取帮助文档'),

    async execute(interaction: any) {
        try {
            await interaction.editReply({
                content: '请访问 https://odyzzeia-discord-bot.github.io/jsbot_doc/',
            });
        } catch (error) {
            assertIsError(error);
            await handleCommandError(interaction, error, '发送通知');
        }
    },
};
