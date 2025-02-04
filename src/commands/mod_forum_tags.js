import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

/**
 * 管理命令 - 添加论坛标签
 * 提供添加论坛标签的基础功能
 * 注意：仅适用于论坛频道
 * 权限要求：管理员或论坛版主
 */
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('添加标签')
        .setDescription('添加新的论坛标签(由于技术限制，标签emoji需手动调整，且最大标签数为20)')
        .addChannelOption(option =>
            option
                .setName('论坛')
                .setDescription('要添加标签的论坛频道')
                .addChannelTypes(ChannelType.GuildForum)
                .setRequired(true),
        )
        .addStringOption(option =>
            option.setName('名称').setDescription('标签名称').setRequired(true).setMinLength(1).setMaxLength(20),
        )
        .addBooleanOption(option => option.setName('仅限版主').setDescription('是否仅限版主使用此标签')),

    async execute(interaction, guildConfig) {
        try {
            const forumChannel = interaction.options.getChannel('论坛');
            const name = interaction.options.getString('名称');
            const moderated = interaction.options.getBoolean('仅限版主') ?? false;

            // 确保是论坛频道
            if (forumChannel.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 指定的频道不是论坛频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查权限
            if (
                !(await checkModeratorPermission(interaction, guildConfig, {
                    requireForumPermission: true,
                    customErrorMessage: '❌ 需要管理员权限或（版主权限+该论坛的管理权限）',
                }))
            ) {
                return;
            }

            // 获取现有标签
            const currentTags = forumChannel.availableTags || [];

            // 检查标签是否已存在
            if (currentTags.some(tag => tag.name === name)) {
                await interaction.editReply({
                    content: '❌ 此标签名称已存在',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 创建新标签
            const newTag = {
                name,
                moderated,
            };

            // 更新标签列表
            await forumChannel.setAvailableTags([...currentTags, newTag]);

            await interaction.editReply({
                content: `✅ 已成功添加标签 "${name}"${moderated ? ' (仅限版主)' : ''}`,
            });

            logTime(`用户 ${interaction.user.tag} 在论坛 ${forumChannel.name} 中添加了标签 ${name}`);
        } catch (error) {
            await handleCommandError(interaction, error, '添加标签');
        }
    },
};
