import { ErrorHandler } from '../utils/errorHandler.js';

/**
 * 处理自动补全交互
 * @param {AutocompleteInteraction} interaction - 自动补全交互对象
 */
export async function handleAutocomplete(interaction) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command?.autocomplete) {
        return;
    }

    // 自动补全失败时返回空数组，避免用户界面卡住
    await ErrorHandler.handleSilent(
        () => command.autocomplete(interaction),
        '自动补全处理'
    ).catch(() => interaction.respond([]));
}
