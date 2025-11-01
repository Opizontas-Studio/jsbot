import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { ThreadBlacklistService } from '../../services/threadBlacklistService.js';
import { handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('查询我的拉黑名单')
        .setDescription('查看你的全局拉黑名单'),

    async execute(interaction, guildConfig) {
        try {
            const userId = interaction.user.id;
            const blacklist = ThreadBlacklistService.getUserBlacklist(userId);

            if (blacklist.length === 0) {
                await interaction.editReply({
                    content: '✅ 你当前没有拉黑任何用户',
                });
                return;
            }

            // 构建拉黑名单Embed
            const embed = new EmbedBuilder()
                .setColor('#FF6B6B')
                .setTitle('📋 你的全局拉黑名单')
                .setDescription(`共拉黑了 **${blacklist.length}** 个用户`)
                .setTimestamp();

            // 获取用户信息并构建列表
            const blacklistEntries = [];
            for (const record of blacklist) {
                try {
                    const targetUser = await interaction.client.users.fetch(record.targetUserId);
                    const addedDate = new Date(record.addedAt).toLocaleDateString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    });

                    // 计算违规次数
                    const violationCount = record.totalViolations || 0;
                    const threadCount = record.threads ? Object.keys(record.threads).length : 0;

                    let entryText = `<@${record.targetUserId}> (\`${targetUser.tag}\`)\n`;
                    entryText += `拉黑时间: ${addedDate}`;

                    if (violationCount > 0) {
                        entryText += ` | 违规: ${violationCount}次/${threadCount}帖`;
                    }

                    blacklistEntries.push(entryText);
                } catch (error) {
                    // 如果无法获取用户信息，显示ID
                    const addedDate = new Date(record.addedAt).toLocaleDateString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    });
                    blacklistEntries.push(
                        `<@${record.targetUserId}> (\`未知用户\`)\n拉黑时间: ${addedDate}`
                    );
                }
            }

            // Discord Embed字段有限制，如果拉黑的人太多，需要分页
            const ENTRIES_PER_FIELD = 10;
            const fields = [];

            for (let i = 0; i < blacklistEntries.length; i += ENTRIES_PER_FIELD) {
                const chunk = blacklistEntries.slice(i, i + ENTRIES_PER_FIELD);
                fields.push({
                    name: i === 0 ? '拉黑用户列表' : '\u200B',
                    value: chunk.join('\n\n'),
                    inline: false
                });
            }

            // 最多显示25个字段（Discord限制）
            if (fields.length > 25) {
                embed.addFields(fields.slice(0, 25));
                embed.setFooter({
                    text: `显示了前 ${Math.min(blacklist.length, 25 * ENTRIES_PER_FIELD)} 个用户，还有 ${blacklist.length - 25 * ENTRIES_PER_FIELD} 个未显示`
                });
            } else {
                embed.addFields(fields);
            }

            embed.addFields({
                name: '💡 提示',
                value: '被拉黑的用户将无法在你创建的所有帖子中发言\n使用用户上下文菜单的「解除拉黑」可以移除拉黑',
                inline: false
            });

            await interaction.editReply({
                embeds: [embed]
            });

            logTime(`[拉黑查询] 用户 ${interaction.user.tag} 查询了自己的拉黑名单（${blacklist.length}个用户）`);
        } catch (error) {
            await handleCommandError(interaction, error, '查询拉黑名单');
        }
    },
};

