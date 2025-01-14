const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { analyzeThreads } = require('../utils/threadAnalyzer');
const config = require('../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analyze')
        .setDescription('分析服务器主题活跃度')
        .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog),

    async execute(interaction) {
        // 权限检查
        const hasPermission = interaction.member.roles.cache.some(role =>
            config.allowedRoleIds.includes(role.id)
        );

        if (!hasPermission) {
            return await interaction.reply({
                content: '你没有权限使用此命令。需要具有指定的身份组权限。',
                ephemeral: true
            });
        }

        try {
            // 发送初始响应
            await interaction.deferReply({ flags: ['Ephemeral'] });

            // 执行分析
            const result = await analyzeThreads(interaction.client, config);

            // 根据分析结果回复
            const replyContent = [
                '✅ 分析完成！',
                `📊 总计分析了 ${result.statistics.totalThreads} 个主题`,
                `⚠️ 处理失败: ${result.failedOperations.length} 个`,
                '',
                '详细报告已发送至指定频道。'
            ].join('\n');

            await interaction.editReply({
                content: replyContent
            });

        } catch (error) {
            console.error('分析执行错误:', error);

            await interaction.editReply({
                content: `执行分析时出现错误: ${error.message}`,
                ephemeral: true
            });
        }
    },
};