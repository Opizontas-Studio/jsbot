import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 查找对应的选择菜单配置
 * @param {string} customId - 选择菜单的自定义ID
 * @returns {Object|null} - 选择菜单配置对象或null
 */
export function findSelectMenuConfig(customId) {
    // 1. 直接匹配
    if (SELECT_MENU_CONFIG[customId]) {
        return SELECT_MENU_CONFIG[customId];
    }

    // 2. 前缀匹配（取前几个部分）
    const parts = customId.split('_');
    for (let i = parts.length - 1; i > 0; i--) {
        const prefix = parts.slice(0, i).join('_');
        if (SELECT_MENU_CONFIG[prefix]) {
            return SELECT_MENU_CONFIG[prefix];
        }
    }

    return null;
}

/**
 * 选择菜单处理器映射
 */
export const selectMenuHandlers = {
    // 移除反应选择菜单处理器
    remove_reaction: async interaction => {
        const [, , messageId, userId] = interaction.customId.split('_');
        const selectedValue = interaction.values[0];

        try {
            // 获取消息对象
            const message = await interaction.channel.messages.fetch(messageId);

            if (!message) {
                await interaction.editReply({
                    content: '❌ 找不到该消息',
                });
                return;
            }

            // 再次验证消息所有权
            if (message.author.id !== userId) {
                await interaction.editReply({
                    content: '❌ 你只能移除自己消息上的反应',
                });
                return;
            }

            // 如果选择"全部"，移除所有反应
            if (selectedValue === 'all') {
                await message.reactions.removeAll();
                await interaction.editReply({
                    content: '✅ 已移除消息的所有反应',
                });
                logTime(`[移除反应] ${interaction.user.tag} 移除了消息 ${messageId} 的所有反应`);
            } else {
                // 移除特定反应
                const reaction = message.reactions.cache.get(selectedValue);
                if (reaction) {
                    await reaction.remove();
                    await interaction.editReply({
                        content: `✅ 已移除反应 ${selectedValue}`,
                    });
                    logTime(`[移除反应] ${interaction.user.tag} 移除了消息 ${messageId} 的反应 ${selectedValue}`);
                } else {
                    await interaction.editReply({
                        content: '❌ 该反应已不存在',
                    });
                }
            }
        } catch (error) {
            await interaction.editReply({
                content: `❌ 移除反应失败: ${error.message}`,
            });
            throw error;
        }
    },
};

// 选择菜单配置对象
const SELECT_MENU_CONFIG = {
    remove_reaction: {
        handler: selectMenuHandlers.remove_reaction,
        needDefer: true
    },
};

/**
 * 统一的选择菜单交互处理函数
 * @param {StringSelectMenuInteraction} interaction - Discord选择菜单交互对象
 */
export async function handleSelectMenu(interaction) {
    // 查找匹配的选择菜单处理配置
    const selectMenuConfig = findSelectMenuConfig(interaction.customId);

    if (!selectMenuConfig) {
        logTime(`未找到选择菜单处理器: ${interaction.customId}`, true);
        return;
    }

    // 根据配置决定是否需要defer
    if (selectMenuConfig.needDefer) {
        await interaction.deferReply({ flags: ['Ephemeral'] });
    }

    await ErrorHandler.handleInteraction(
        interaction,
        () => selectMenuConfig.handler(interaction),
        '选择菜单交互处理',
        { ephemeral: true }
    );
}

