import { handleRemoveReaction } from '../services/selfManageService.js';
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

        await handleRemoveReaction(interaction, messageId, userId, selectedValue);
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

