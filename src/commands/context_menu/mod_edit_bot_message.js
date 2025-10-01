import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { ModalFactory } from '../../factories/modalFactory.js';
import { checkModeratorPermission } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('编辑Bot消息')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        // 检查管理员权限
        if (!(await checkModeratorPermission(interaction, guildConfig))) {
            return;
        }

        const targetMessage = interaction.targetMessage;

        // 检查消息是否由bot发送
        if (targetMessage.author.id !== interaction.client.user.id) {
            throw new Error('只能编辑由机器人发送的消息');
        }

        // 获取当前消息内容
        const currentContent = targetMessage.content || '';

        // 创建编辑模态框
        const editModal = ModalFactory.createEditBotMessageModal(
            targetMessage.id,
            currentContent
        );

        // 显示模态框
        await interaction.showModal(editModal);

        logTime(`[编辑消息] 用户 ${interaction.user.tag} 开始编辑消息 ${targetMessage.id}`);
    },
};
