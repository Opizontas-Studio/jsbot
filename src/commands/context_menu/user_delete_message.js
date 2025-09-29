import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder } from 'discord.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助删楼')
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
            // 保存消息内容和发送者信息用于日志
            const messageContent = message.content;
            const messageAuthor = message.author;

            // 删除消息
            await message.delete();

            await interaction.editReply({
                content: `✅ 已删除 ${messageAuthor.tag} 发送的消息`,
                flags: ['Ephemeral'],
            });

            // 记录日志
            logTime(`[自助管理] 楼主 ${interaction.user.tag} 在帖子 ${thread.name} 中删除了 ${messageAuthor.tag} 发送的消息，内容：${messageContent}`);
        } catch (error) {
            await interaction.editReply({
                content: `❌ 删除消息失败: ${error.message}`,
                flags: ['Ephemeral'],
            });
            throw error;
        }
    },
};
