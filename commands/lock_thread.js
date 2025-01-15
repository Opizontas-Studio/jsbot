const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime, checkChannelPermission } = require('../utils/common');

/**
 * 锁定命令 - 锁定并归档当前论坛帖子
 * 仅在论坛帖子中可用，锁定后帖子将无法继续回复且会被归档
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('一键锁定关贴')
        .setDescription('锁定并归档当前论坛帖子')
        .addStringOption(option =>
            option.setName('理由')
                .setDescription('处理原因')
                .setRequired(true)
        ),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        const hasPermission = checkChannelPermission(
            interaction.member, 
            interaction.channel,
            guildConfig.allowedRoleIds
        );
        
        if (!hasPermission) {
            await interaction.reply({
                content: '你没有权限锁定此帖子。需要具有该论坛的消息管理权限。',
                flags: ['Ephemeral']
            });
            return;
        }

        // 验证当前频道是否为论坛帖子
        if (!interaction.channel.isThread()) {
            await interaction.reply({
                content: '❌ 当前频道不是子区或帖子',
                flags: ['Ephemeral']
            });
            return;
        }

        // 检查父频道是否为论坛
        const parentChannel = interaction.channel.parent;
        if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
            await interaction.reply({
                content: '❌ 此子区不属于论坛频道',
                flags: ['Ephemeral']
            });
            return;
        }

        const reason = interaction.options.getString('理由');
        const thread = interaction.channel;

        try {
            // 锁定并归档主题
            await thread.setLocked(true, reason);
            await thread.setArchived(true, reason);

            // 发送操作日志到管理频道
            const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
            await moderationChannel.send({
                embeds: [{
                    color: 0xff0000,
                    title: '管理员锁定并归档帖子',
                    fields: [
                        {
                            name: '操作人',
                            value: `<@${interaction.user.id}>`,
                            inline: true
                        },
                        {
                            name: '主题',
                            value: `[${thread.name}](${thread.url})`,
                            inline: true
                        },
                        {
                            name: '原因',
                            value: reason,
                            inline: false
                        }
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: '论坛管理系统'
                    }
                }]
            });

            // 在主题中发送通知
            await thread.send({
                embeds: [{
                    color: 0xff0000,
                    title: '管理员锁定并归档了此帖子',
                    fields: [
                        {
                            name: '操作人',
                            value: `<@${interaction.user.id}>`,
                            inline: true
                        },
                        {
                            name: '原因',
                            value: reason,
                            inline: true
                        }
                    ],
                    timestamp: new Date()
                }]
            });

            // 回复操作者
            await interaction.reply({
                content: `✅ 已成功锁定并归档帖子 "${thread.name}"`,
                flags: ['Ephemeral']
            });

            logTime(`用户 ${interaction.user.tag} 锁定并归档了帖子 ${thread.name}`);

        } catch (error) {
            logTime(`锁定帖子时出错: ${error}`, true);
            await interaction.reply({
                content: `❌ 锁定帖子时出错: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 