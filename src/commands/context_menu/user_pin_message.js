import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder } from 'discord.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助标注或取消标注')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        // 检查是否在论坛帖子中使用
        if (!interaction.channel.isThread() || !interaction.channel.parent?.type === ChannelType.GuildForum) {
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

        try {
            // 检查消息是否已标注
            const isPinned = message.pinned;

            if (isPinned) {
                await message.unpin();
                await interaction.editReply({
                    content: '✅ 消息已取消标注',
                });
                logTime(`[自助管理] 楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
            } else {
                await message.pin();
                await interaction.editReply({
                    content: '✅ 消息已标注',
                });
                logTime(`[自助管理] 楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
            }
        } catch (error) {
            await interaction.editReply({
                content: `❌ 操作失败: ${error.message}`,
            });
            throw error;
        }
    },
};
