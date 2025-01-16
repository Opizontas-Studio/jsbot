const { Events, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { logTime } = require('../utils/helper');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isButton()) return;

        if (interaction.customId === 'apply_creator_role') {
            const modal = new ModalBuilder()
                .setCustomId('creator_role_modal')
                .setTitle('创作者身份组申请');

            const threadLinkInput = new TextInputBuilder()
                .setCustomId('thread_link')
                .setLabel('请输入作品帖子链接')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例如：https://discord.com/channels/...')
                .setRequired(true);

            const firstActionRow = new ActionRowBuilder().addComponents(threadLinkInput);
            modal.addComponents(firstActionRow);

            await interaction.showModal(modal);
        }
    }
}; 