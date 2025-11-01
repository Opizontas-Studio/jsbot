import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { validateForumThread } from '../../services/selfManageService.js';
import { ThreadBlacklistService } from '../../services/threadBlacklistService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('解除拉黑')
        .setType(ApplicationCommandType.User),

    async execute(interaction, guildConfig) {
        const thread = interaction.channel;
        const targetUser = interaction.targetUser;

        // 检查是否在论坛帖子中使用
        const forumValidation = validateForumThread(thread);
        if (!forumValidation.isValid) {
            await interaction.editReply({
                content: forumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为帖子作者或管理员
        const isOwner = thread.ownerId === interaction.user.id;
        const moderatorRoles = guildConfig.ModeratorRoleIds || [];
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const isModerator = member.roles.cache.some(role => moderatorRoles.includes(role.id));

        if (!isOwner && !isModerator) {
            await interaction.editReply({
                content: '❌ 只有帖子作者或管理员才能解除拉黑',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查目标用户是否在拉黑列表中
        const blacklistRecord = ThreadBlacklistService.isUserBlacklisted(thread.ownerId, targetUser.id);
        if (!blacklistRecord) {
            await interaction.editReply({
                content: `⚠️ 用户 ${targetUser.tag} 未被你拉黑`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 执行解除拉黑操作
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const success = ThreadBlacklistService.removeUserFromBlacklist(thread.ownerId, targetUser.id);

                if (success) {
                    // 获取违规统计信息
                    const stats = blacklistRecord.threads[thread.id];
                    const statsText = stats
                        ? `\n📊 该用户在此帖子中曾违规 ${stats.violationCount} 次`
                        : '';

                    await interaction.editReply({
                        content: `✅ 已解除对用户 ${targetUser.tag} 的全局拉黑\n该用户可以重新在你的所有帖子中发言${statsText}`,
                        flags: ['Ephemeral'],
                    });

                    logTime(`[用户拉黑] ${interaction.user.tag} 解除了对 ${targetUser.tag} 的全局拉黑`);
                } else {
                    throw new Error('解除拉黑失败');
                }
            },
            '解除拉黑',
            {
                ephemeral: true,
                successMessage: null // 已在上面处理
            }
        );
    },
};

