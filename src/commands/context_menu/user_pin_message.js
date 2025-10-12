import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder } from 'discord.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助标注或取消标注')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        // 检查是否在论坛帖子中使用
        if (!interaction.channel.isThread() || interaction.channel.parent?.type !== ChannelType.GuildForum) {
            await interaction.editReply({
                content: '❌ 此命令只能在论坛帖子中使用',
                flags: ['Ephemeral'],
            });
            return;
        }

        const thread = interaction.channel;
        const message = interaction.targetMessage;

        // 检查是否为帖子作者
        if (thread.ownerId !== interaction.user.id) {
            await interaction.editReply({
                content: '❌ 只有帖子作者才能管理此帖子',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 执行标注/取消标注操作
        const isPinned = message.pinned;
        const action = isPinned ? '取消标注' : '标注';

        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                if (isPinned) {
                    await message.unpin();
                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                } else {
                    await message.pin();
                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                }
            },
            `${action}消息`,
            {
                ephemeral: false,
                successMessage: `消息已${action}`
            }
        );
    },
};
