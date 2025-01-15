const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime, checkChannelPermission } = require('../utils/common');

/**
 * 管理命令 - 管理论坛帖子
 * 提供锁定、解锁、归档等管理功能
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('管理帖子')
        .setDescription('管理论坛帖子')
        .addStringOption(option =>
            option.setName('帖子id')
                .setDescription('要管理的帖子ID')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('操作')
                .setDescription('处理方针')
                .setRequired(true)
                .addChoices(
                    { name: '锁定', value: 'lock' },
                    { name: '解锁', value: 'unlock' },
                    { name: '归档', value: 'archive' }
                )
        )
        .addStringOption(option =>
            option.setName('理由')
                .setDescription('处理原因')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads),

    async execute(interaction, guildConfig) {
        const threadId = interaction.options.getString('帖子id');
        
        try {
            // 获取目标帖子
            const thread = await interaction.guild.channels.fetch(threadId);
            
            if (!thread || !thread.isThread()) {
                await interaction.reply({
                    content: '❌ 指定的ID不是有效的子区或帖子',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 检查用户是否有执行权限
            const hasPermission = checkChannelPermission(
                interaction.member,
                thread,
                guildConfig.allowedRoleIds
            );
            
            if (!hasPermission) {
                await interaction.reply({
                    content: '你没有权限管理此帖子。需要具有该论坛的消息管理权限。',
                    flags: ['Ephemeral']
                });
                return;
            }

            const action = interaction.options.getString('操作');
            const reason = interaction.options.getString('理由');

            // 检查父频道是否为论坛
            const parentChannel = thread.parent;
            if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
                await interaction.reply({
                    content: '❌ 此子区不属于论坛频道',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 执行操作
            let actionResult;
            switch (action) {
                case 'lock':
                    actionResult = await thread.setLocked(true, reason);
                    break;
                case 'unlock':
                    actionResult = await thread.setLocked(false, reason);
                    break;
                case 'archive':
                    actionResult = await thread.setArchived(true, reason);
                    break;
            }

            // 构建操作描述
            const actionDesc = {
                lock: '锁定',
                unlock: '解锁',
                archive: '归档'
            }[action];

            // 发送操作日志到管理频道
            const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
            await moderationChannel.send({
                embeds: [{
                    color: 0x0099ff,
                    title: `管理员${actionDesc}帖子`,
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
                    color: 0xffcc00,
                    title: `管理员${actionDesc}了此帖`,
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
                content: `✅ 已成功${actionDesc}帖子 "${thread.name}"`,
                flags: ['Ephemeral']
            });

            logTime(`用户 ${interaction.user.tag} ${actionDesc}了帖子 ${thread.name}`);

        } catch (error) {
            logTime(`管理帖子时出错: ${error}`, true);
            await interaction.reply({
                content: `❌ 执行操作时出错: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 