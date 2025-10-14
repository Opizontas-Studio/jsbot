import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { ModalFactory } from '../../factories/modalFactory.js';
import { validateForumThread, validateThreadOwner } from '../../services/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';

export default {
    cooldown: 30,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助解锁帖子')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        const thread = interaction.channel;

        // 验证当前频道是否为论坛帖子
        if (!thread.isThread()) {
            await interaction.reply({
                content: '❌ 此功能只能在论坛子区中使用',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否在论坛帖子中使用
        const forumValidation = validateForumThread(thread);
        if (!forumValidation.isValid) {
            await interaction.reply({
                content: forumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为帖子作者
        const ownerValidation = validateThreadOwner(thread, interaction.user.id);
        if (!ownerValidation.isValid) {
            await interaction.reply({
                content: '❌ 只有作者本人才能申请解锁',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查子区是否已锁定
        if (!thread.locked) {
            await interaction.reply({
                content: '❌ 此子区未被锁定，无需申请解锁',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否配置了opinionMailThreadId
        if (!guildConfig?.opinionMailThreadId) {
            await interaction.reply({
                content: '❌ 服务器未配置解锁申请功能',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 显示解锁申请表单
        await ErrorHandler.handleService(
            async () => {
                const modal = ModalFactory.createUnlockThreadModal(thread.id);
                await interaction.showModal(modal);
            },
            '显示解锁申请表单',
            { throwOnError: true }
        );
    },
};

