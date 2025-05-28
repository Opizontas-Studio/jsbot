import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const qualifiedUsersPath = join(process.cwd(), 'data', 'qualifiedSuggestionUsers.json');

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('查看合格建议记录')
        .setDescription('查看提交过合格建议的用户记录')
        .addSubcommand(subcommand =>
            subcommand
                .setName('列表')
                .setDescription('查看所有合格建议用户列表')
                .addIntegerOption(option =>
                    option
                        .setName('页码')
                        .setDescription('页码（每页10个用户）')
                        .setMinValue(1)
                ))
        .addSubcommand(subcommand =>
            subcommand
                .setName('用户详情')
                .setDescription('查看特定用户的建议记录')
                .addUserOption(option =>
                    option
                        .setName('用户')
                        .setDescription('要查看记录的用户')
                        .setRequired(true)
                )),

    async execute(interaction, guildConfig) {
        // 检查管理员权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === '列表') {
                await showUsersList(interaction);
            } else if (subcommand === '用户详情') {
                await showUserDetails(interaction);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '查看合格建议记录');
        }
    },
};

/**
 * 显示合格建议用户列表
 * @param {Interaction} interaction - 斜杠命令交互对象
 */
async function showUsersList(interaction) {
    try {
        const data = JSON.parse(readFileSync(qualifiedUsersPath, 'utf8'));
        const users = Object.entries(data.users);
        const page = interaction.options.getInteger('页码') || 1;
        const pageSize = 10;
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const pageUsers = users.slice(startIndex, endIndex);
        const totalPages = Math.ceil(users.length / pageSize);

        if (users.length === 0) {
            await interaction.editReply({
                content: '❌ 暂无合格建议用户记录',
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('📋 合格建议用户列表')
            .setColor(0x0099ff)
            .setFooter({
                text: `第 ${page} 页，共 ${totalPages} 页 | 总计 ${users.length} 个用户`,
            });

        let description = '';
        for (let i = 0; i < pageUsers.length; i++) {
            const [userId, userRecord] = pageUsers[i];
            const userMention = `<@${userId}>`;
            const suggestionCount = userRecord.suggestions.length;
            const firstQualifiedDate = new Date(userRecord.firstQualifiedAt).toLocaleDateString('zh-CN');

            description += `**${startIndex + i + 1}.** ${userMention}\n`;
            description += `📅 首次合格：${firstQualifiedDate}\n`;
            description += `📝 合格建议数：${suggestionCount}\n\n`;
        }

        embed.setDescription(description || '暂无数据');

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        logTime(`查看合格建议用户列表失败: ${error.message}`, true);
        await interaction.editReply({
            content: '❌ 读取用户记录时出错',
        });
    }
}

/**
 * 显示特定用户的建议详情
 * @param {Interaction} interaction - 斜杠命令交互对象
 */
async function showUserDetails(interaction) {
    try {
        const targetUser = interaction.options.getUser('用户');
        const data = JSON.parse(readFileSync(qualifiedUsersPath, 'utf8'));
        const userRecord = data.users[targetUser.id];

        if (!userRecord) {
            await interaction.editReply({
                content: `❌ 用户 ${targetUser.tag} 没有合格建议记录`,
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📝 ${targetUser.tag} 的合格建议记录`)
            .setColor(0x00ff00)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                {
                    name: '📅 首次合格时间',
                    value: new Date(userRecord.firstQualifiedAt).toLocaleString('zh-CN'),
                    inline: true,
                },
                {
                    name: '📊 合格建议总数',
                    value: `${userRecord.suggestions.length} 条`,
                    inline: true,
                }
            );

        // 显示最近的5条建议
        const recentSuggestions = userRecord.suggestions
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 5);

        if (recentSuggestions.length > 0) {
            let suggestionsText = '';
            recentSuggestions.forEach((suggestion, index) => {
                const date = new Date(suggestion.timestamp).toLocaleDateString('zh-CN');
                suggestionsText += `**${index + 1}.** ${suggestion.title}\n`;
                suggestionsText += `🗓️ ${date} | 👍 ${suggestion.reactionCount} 个认可\n\n`;
            });

            embed.addFields({
                name: '📋 最近合格建议（最多显示5条）',
                value: suggestionsText,
                inline: false,
            });
        }

        await interaction.editReply({
            embeds: [embed],
        });
    } catch (error) {
        logTime(`查看用户建议详情失败: ${error.message}`, true);
        await interaction.editReply({
            content: '❌ 读取用户记录时出错',
        });
    }
}
