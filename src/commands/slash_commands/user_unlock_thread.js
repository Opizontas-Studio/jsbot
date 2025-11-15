import { SlashCommandBuilder } from 'discord.js';
import { ModalFactory } from '../../factories/modalFactory.js';
import { validateForumThread, validateThreadOwner } from '../../services/thread/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';

export default {
    cooldown: 30,
    ephemeral: true,
    shouldDefer: false, // 此命令会显示 modal，不需要 defer
    data: new SlashCommandBuilder()
        .setName('申请解锁帖子')
        .setDescription('申请解锁被锁定的论坛帖子')
        .addStringOption(option =>
            option
                .setName('帖子链接')
                .setDescription('要解锁的帖子链接')
                .setRequired(true),
        ),

    async execute(interaction, guildConfig) {
        const threadUrl = interaction.options.getString('帖子链接');

        // 解析帖子链接
        const matches = threadUrl.match(/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
        if (!matches) {
            await interaction.reply({
                content: '❌ 无效的帖子链接格式',
                flags: ['Ephemeral'],
            });
            return;
        }

        const [, guildId, threadId] = matches;

        // 验证链接是否为当前服务器
        if (guildId !== interaction.guildId) {
            await interaction.reply({
                content: '❌ 只能申请解锁当前服务器的帖子',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 获取帖子对象
        let targetThread;
        try {
            targetThread = await interaction.client.channels.fetch(threadId);
        } catch (error) {
            await interaction.reply({
                content: '❌ 无法获取帖子，请检查链接是否正确',
                flags: ['Ephemeral'],
            });
            return;
        }

        if (!targetThread) {
            await interaction.reply({
                content: '❌ 找不到指定的帖子',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 验证是否为论坛帖子
        const threadForumValidation = validateForumThread(targetThread);
        if (!threadForumValidation.isValid) {
            await interaction.reply({
                content: threadForumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 验证是否为帖子作者
        const threadOwnerValidation = validateThreadOwner(targetThread, interaction.user.id);
        if (!threadOwnerValidation.isValid) {
            await interaction.reply({
                content: '❌ 只有帖子作者才能申请解锁',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查帖子是否已锁定
        if (!targetThread.locked) {
            await interaction.reply({
                content: '❌ 此帖子未被锁定，无需申请解锁',
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
                const modal = ModalFactory.createUnlockThreadModal(targetThread.id);
                await interaction.showModal(modal);
            },
            '显示解锁申请表单',
            { throwOnError: true }
        );
    },
};

