import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder } from 'discord.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助删楼')
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

        // 保存消息信息用于日志和回复
        const messageContent = message.content;
        const messageAuthor = message.author;

        // 执行删除操作
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                await message.delete();
                logTime(`[自助管理] 楼主 ${interaction.user.tag} 在帖子 ${thread.name} 中删除了 ${messageAuthor.tag} 发送的消息，内容：${messageContent}`);
            },
            '删除消息',
            {
                ephemeral: true,
                successMessage: `已删除 ${messageAuthor.tag} 发送的消息`
            }
        );
    },
};
