const { 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder
} = require('discord.js');
const { handleCommandError } = require('../utils/helper');

module.exports = {
    // 设置命令冷却时间为5秒
    cooldown: 5,
    
    // 定义命令
    data: new SlashCommandBuilder()
        .setName('发送通知')
        .setDescription('在当前频道发送一个通知控件')
        // 设置命令需要的默认权限为管理消息
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction, guildConfig) {
        try {
            // 检查用户是否有管理消息的权限
            const channel = interaction.channel;
            const memberPermissions = channel.permissionsFor(interaction.member);
            
            if (!memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                await interaction.reply({
                    content: '你没有权限发送通知。需要具有管理消息的权限。',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 创建模态框
            const modal = new ModalBuilder()
                .setCustomId('notifyModal')
                .setTitle('发送通知');

            // 创建标题输入框
            const titleInput = new TextInputBuilder()
                .setCustomId('titleInput')
                .setLabel('通知标题')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('请输入通知标题')
                .setMaxLength(256)
                .setRequired(true);

            // 创建内容输入框
            const contentInput = new TextInputBuilder()
                .setCustomId('contentInput')
                .setLabel('通知内容')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('请输入通知内容（支持多行文本）')
                .setMaxLength(4096)
                .setRequired(true);

            // 创建输入框行
            const titleRow = new ActionRowBuilder().addComponents(titleInput);
            const contentRow = new ActionRowBuilder().addComponents(contentInput);

            // 添加输入框到模态框
            modal.addComponents(titleRow, contentRow);

            // 显示模态框
            await interaction.showModal(modal);

            // 等待模态框提交
            const submitted = await interaction.awaitModalSubmit({
                time: 300000,
                filter: i => i.customId === 'notifyModal' && i.user.id === interaction.user.id,
            }).catch(() => null);

            // 如果用户没有提交，直接返回
            if (!submitted) return;

            // 立即发送延迟响应
            await submitted.deferReply({ flags: ['Ephemeral'] });

            // 获取用户输入的值
            const title = submitted.fields.getTextInputValue('titleInput');
            const description = submitted.fields.getTextInputValue('contentInput');

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
            await submitted.editReply({
                content: '✅ 通知已发送'
            });

        } catch (error) {
            await handleCommandError(interaction, error, '发送通知');
        }
    },
}; 