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
        const channel = interaction.channel;
        const targetUser = interaction.targetUser;

        // 判断是否在论坛帖子中
        const isInThread = channel.isThread();
        const forumValidation = isInThread ? validateForumThread(channel) : { isValid: false };
        const isInForumThread = forumValidation.isValid;

        // 确定拉黑关系的创建者
        // 在论坛帖子中：帖子作者（无论谁操作）
        // 在其他地方：操作者自己
        const blacklistOwnerId = isInForumThread ? channel.ownerId : interaction.user.id;

        // 权限检查
        const moderatorRoles = guildConfig.ModeratorRoleIds || [];
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const isModerator = member.roles.cache.some(role => moderatorRoles.includes(role.id));

        if (isInForumThread) {
            // 在论坛帖子中，需要是帖子作者或管理员
            const isOwner = channel.ownerId === interaction.user.id;
            if (!isOwner && !isModerator) {
                await interaction.editReply({
                    content: '❌ 只有帖子作者或管理员才能解除拉黑',
                    flags: ['Ephemeral'],
                });
                return;
            }
        }
        // 在其他地方，任何人都可以使用（解除自己和目标用户的拉黑关系）

        // 检查目标用户是否在拉黑列表中
        const blacklistRecord = ThreadBlacklistService.isUserBlacklisted(blacklistOwnerId, targetUser.id);
        if (!blacklistRecord) {
            const ownerText = isInForumThread ? '帖子作者' : '你';
            await interaction.editReply({
                content: `⚠️ 用户 ${targetUser.tag} 未被${ownerText}拉黑`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 执行解除拉黑操作
        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const success = ThreadBlacklistService.removeUserFromBlacklist(blacklistOwnerId, targetUser.id);

                if (success) {
                    // 获取违规统计信息（仅在论坛帖子中显示）
                    const ownerText = isInForumThread && channel.ownerId !== interaction.user.id ? '帖子作者' : '你';
                    let statsText = '';
                    if (isInForumThread && blacklistRecord.threads && blacklistRecord.threads[channel.id]) {
                        const stats = blacklistRecord.threads[channel.id];
                        statsText = `\n📊 该用户在此帖子中曾违规 ${stats.violationCount} 次`;
                    }

                    await interaction.editReply({
                        content: `✅ 已解除对用户 ${targetUser.tag} 的全局拉黑\n该用户可以重新在${ownerText}的所有帖子中发言${statsText}`,
                        flags: ['Ephemeral'],
                    });

                    logTime(`[用户拉黑] ${interaction.user.tag} ${isInForumThread && channel.ownerId !== interaction.user.id ? '为帖子作者' : ''}解除了对 ${targetUser.tag} 的全局拉黑`);
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

