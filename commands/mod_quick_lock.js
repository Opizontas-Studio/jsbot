const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { logTime, handleCommandError, lockAndArchiveThreadWithLog } = require('../utils/helper');

module.exports = {
    cooldown: 10, // 设置10秒冷却时间
    data: new SlashCommandBuilder()
        .setName('一键锁定关贴')
        .setDescription('锁定并归档当前论坛帖子')
        .addStringOption(option =>
            option.setName('理由')
                .setDescription('处理原因')
                .setRequired(true)
        )
        // 设置命令需要的默认权限为管理消息
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction, guildConfig) {
        try {
            // 立即发送延迟响应
            await interaction.deferReply({ flags: ['Ephemeral'] });

            // 检查用户是否有管理消息的权限
            const channel = interaction.channel;
            const memberPermissions = channel.permissionsFor(interaction.member);
            
            if (!memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                await interaction.editReply({
                    content: '你没有权限锁定此帖子。需要具有管理消息的权限。'
                });
                return;
            }

            // 验证当前频道是否为论坛帖子
            if (!interaction.channel.isThread()) {
                await interaction.editReply({
                    content: '❌ 当前频道不是子区或帖子'
                });
                return;
            }

            // 检查父频道是否为论坛
            const parentChannel = interaction.channel.parent;
            if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 此子区不属于论坛频道'
                });
                return;
            }

            const reason = interaction.options.getString('理由');
            const thread = interaction.channel;

            // 执行锁定操作
            await lockAndArchiveThreadWithLog(thread, interaction.user, reason, guildConfig);

            await interaction.editReply({
                content: `✅ 已成功锁定并归档帖子 "${thread.name}"`
            });

        } catch (error) {
            await handleCommandError(interaction, error, '一键锁定关贴');
        }
    },
};