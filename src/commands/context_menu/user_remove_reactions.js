import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { SelectMenuFactory } from '../../factories/selectMenuFactory.js';
import { validateMessageOwner } from '../../services/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助移除消息反应')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        const message = interaction.targetMessage;

        // 检查消息是否为用户自己发送的
        const ownerValidation = validateMessageOwner(message, interaction.user.id);
        if (!ownerValidation.isValid) {
            await interaction.editReply({
                content: ownerValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查消息是否有反应
        if (message.reactions.cache.size === 0) {
            await interaction.editReply({
                content: '❌ 该消息没有任何反应',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 构建反应选择菜单
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const row = SelectMenuFactory.createReactionRemovalMenu(message, interaction.user.id);

                // 直接编辑回复，不通过handleInteraction的successMessage
                await interaction.editReply({
                    content: '请选择要移除的反应：',
                    components: [row],
                    flags: ['Ephemeral'],
                });
            },
            '构建反应选择菜单',
            { ephemeral: true }
        );
    },
};

