import { Events } from 'discord.js';
import { handleAutocomplete } from '../handlers/autocomplete.js';
import { handleButton } from '../handlers/buttons.js';
import { handleCommand } from '../handlers/commands.js';
import { handleModal } from '../handlers/modals.js';
import { handleSelectMenu } from '../handlers/selectMenus.js';

/**
 * 处理Discord交互事件
 * @param {Interaction} interaction - Discord交互对象
 */
export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // 处理按钮交互
        if (interaction.isButton()) {
            await handleButton(interaction);
            return;
        }

        // 处理选择菜单交互
        if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction);
            return;
        }

        // 处理模态框提交
        if (interaction.isModalSubmit()) {
            await handleModal(interaction);
            return;
        }

        // 处理自动补全请求
        if (interaction.isAutocomplete()) {
            await handleAutocomplete(interaction);
            return;
        }

        // 处理斜杠命令
        if (interaction.isChatInputCommand()) {
            await handleCommand(interaction);
            return;
        }

        // 处理上下文菜单命令
        if (interaction.isContextMenuCommand()) {
            await handleCommand(interaction);
            return;
        }
    },
};
