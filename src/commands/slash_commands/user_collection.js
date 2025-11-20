import { SlashCommandBuilder } from 'discord.js';
import { collectionService } from '../../services/user/collectionService.js';
import { handleCommandError } from '../../utils/helper.js';

export default {
    cooldown: 10,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('合集')
        .setDescription('查看作者的作品合集')
        .addUserOption(option =>
            option.setName('作者')
                .setDescription('选择作者（不填且在帖子内使用则查看当前帖子作者）')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            let targetUser = interaction.options.getUser('作者');

            // 如果未指定作者，尝试获取当前子区的作者
            if (!targetUser) {
                if (interaction.channel?.isThread()) {
                    targetUser = await interaction.client.users.fetch(interaction.channel.ownerId)
                        .catch(() => ({ id: interaction.channel.ownerId, username: '未知用户' }));
                } else {
                    throw new Error('请指定作者，或在帖子内使用此命令以查看帖子作者的合集。');
                }
            }

            const result = await collectionService.buildCollectionMessage({
                authorId: targetUser.id,
                authorUser: targetUser,
                page: 1,
                client: interaction.client
            });

            await interaction.editReply(result);

        } catch (error) {
            await handleCommandError(interaction, error, '查看作品合集');
        }
    }
};

