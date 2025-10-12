import {
    ActionRowBuilder,
    ApplicationCommandType,
    ContextMenuCommandBuilder,
    StringSelectMenuBuilder
} from 'discord.js';
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
        if (message.author.id !== interaction.user.id) {
            await interaction.editReply({
                content: '❌ 你只能移除自己消息上的反应',
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
                // 构建选择菜单选项
                const options = [
                    {
                        label: '全部',
                        description: '移除所有反应',
                        value: 'all',
                        emoji: '🗑️',
                    }
                ];

                // 添加每个单独的反应选项
                for (const [emoji, reaction] of message.reactions.cache) {
                    options.push({
                        label: `${reaction.emoji.name || emoji}`,
                        description: `${reaction.count} 个反应`,
                        value: emoji,
                        emoji: reaction.emoji.id ? { id: reaction.emoji.id } : reaction.emoji.name,
                    });
                }

                // 创建选择菜单
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`remove_reaction_${message.id}_${interaction.user.id}`)
                    .setPlaceholder('选择要移除的反应')
                    .addOptions(options);

                const row = new ActionRowBuilder().addComponents(selectMenu);

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

