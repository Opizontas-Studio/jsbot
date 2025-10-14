import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

/**
 * 选择菜单工厂类
 * 负责创建各种Discord选择菜单组件
 */
export class SelectMenuFactory {

    /**
     * 创建移除反应选择菜单
     * @param {Object} message - 消息对象
     * @param {string} userId - 用户ID
     * @returns {Object} 包含选择菜单的ActionRow
     */
    static createReactionRemovalMenu(message, userId) {
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

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`remove_reaction_${message.id}_${userId}`)
            .setPlaceholder('选择要移除的反应')
            .addOptions(options);

        return new ActionRowBuilder().addComponents(selectMenu);
    }
}

