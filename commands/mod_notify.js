const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { handleCommandError } = require('../utils/helper');

module.exports = {
    // 设置命令冷却时间为5秒
    cooldown: 5,
    
    // 定义命令
    data: new SlashCommandBuilder()
        .setName('发送通知')
        .setDescription('在当前频道发送一个通知控件')
        .addStringOption(option =>
            option.setName('标题')
                .setDescription('通知的标题')
                .setRequired(true)
                .setMaxLength(256) // Discord embed标题最大长度
        )
        .addStringOption(option =>
            option.setName('内容')
                .setDescription('通知的具体内容')
                .setRequired(true)
                .setMaxLength(4096) // Discord embed描述最大长度
        )
        // 设置命令需要的默认权限为管理消息
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction, guildConfig) {
        try {
            // 立即发送延迟响应
            await interaction.deferReply({ ephemeral: true });

            // 检查用户是否有管理消息的权限
            const channel = interaction.channel;
            const memberPermissions = channel.permissionsFor(interaction.member);
            
            if (!memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                await interaction.editReply({
                    content: '你没有权限发送通知。需要具有管理消息的权限。'
                });
                return;
            }

            // 获取参数
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('内容');

            // 创建并发送embed消息
            await channel.send({
                embeds: [{
                    color: 0x0099ff, // 蓝色
                    title: title,
                    description: description,
                    timestamp: new Date(),
                    footer: {
                        text: `由 ${interaction.user.tag} 发送`
                    }
                }]
            });

            // 回复成功消息
            await interaction.editReply({
                content: '✅ 通知已发送'
            });

        } catch (error) {
            await handleCommandError(interaction, error, '发送通知');
        }
    },
}; 