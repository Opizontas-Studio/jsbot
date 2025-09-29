import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../../utils/helper.js';

export default {
    // 设置命令冷却时间为10秒
    cooldown: 10,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('回顶')
        .setDescription('创建一个回到顶部的按钮'),

    async execute(interaction) {
        try {
            // 创建一个链接按钮，指向频道顶部
            const topButton = new ButtonBuilder()
                .setLabel('回顶！')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/0`);

            // 创建按钮行
            const row = new ActionRowBuilder().addComponents(topButton);

            // 创建embed
            const embed = {
                color: 0x0099ff,
                description: '请点击下方按钮立刻回到频道顶部',
                timestamp: new Date(),
            };

            await interaction.editReply({
                embeds: [embed],
                components: [row],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '回顶');
        }
    },
};
