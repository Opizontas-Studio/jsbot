import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { togglePinMessage, validateForumThread, validateThreadOwner } from '../../services/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助标注或取消标注')
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

        // 执行标注/取消标注操作
        const isPinned = message.pinned;
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const result = await togglePinMessage(message, interaction.user, thread);
                return result;
            },
            '标注/取消标注消息',
            {
                ephemeral: false,
                successMessage: `消息已${isPinned ? '取消标注' : '标注'}`
            }
        );
    },
};
