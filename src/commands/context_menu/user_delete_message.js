import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { deleteMessage, validateForumThread, validateThreadOwner } from '../../services/thread/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助删楼')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        const thread = interaction.channel;
        const message = interaction.targetMessage;

        // 检查是否在论坛帖子中使用
        const forumValidation = validateForumThread(thread);
        if (!forumValidation.isValid) {
            await interaction.editReply({
                content: forumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为帖子作者
        const ownerValidation = validateThreadOwner(thread, interaction.user.id);
        if (!ownerValidation.isValid) {
            await interaction.editReply({
                content: ownerValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 执行删除操作
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const result = await deleteMessage(message, interaction.user, thread);
                return result;
            },
            '删除消息',
            {
                ephemeral: true,
                successMessage: `已删除 ${message.author.tag} 发送的消息`
            }
        );
    },
};
