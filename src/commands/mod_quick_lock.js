import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { checkModeratorPermission, handleCommandError, lockAndArchiveThread } from '../utils/helper.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('一键锁定关贴')
        .setDescription('锁定并归档当前论坛帖子')
        .addStringOption(option => option.setName('理由').setDescription('处理原因').setRequired(true)),

    async execute(interaction, guildConfig) {
        try {
            // 验证当前频道是否为论坛帖子
            if (!interaction.channel.isThread()) {
                await interaction.editReply({
                    content: '❌ 当前频道不是子区或帖子',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查父频道是否为论坛
            const parentChannel = interaction.channel.parent;
            if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 此子区不属于论坛频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查用户权限
            if (!(await checkModeratorPermission(interaction, guildConfig, { requireForumPermission: true }))) {
                return;
            }

            const reason = interaction.options.getString('理由');
            const thread = interaction.channel;

            // 执行锁定操作
            await lockAndArchiveThread(thread, interaction.user, reason, {
                isAdmin: true,
                guildConfig,
            });

            await interaction.editReply({
                content: `✅ 已成功锁定并归档帖子 "${thread.name}"`,
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '一键锁定关贴');
        }
    },
};
