const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { analyzeThreads } = require('../utils/threadAnalyzer');
const config = require('../config.json');
const { checkPermission, handlePermissionResult, measureTime } = require('../utils/common');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analyze')
        .setDescription('分析论坛主题活跃度统计')
        .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog),

    async execute(interaction) {
        // 权限检查
        const hasPermission = checkPermission(interaction.member, config.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        const executionTimer = measureTime();

        try {
            // 发送初始响应
            await interaction.deferReply({ flags: ['Ephemeral'] });

            // 执行分析
            const result = await analyzeThreads(interaction.client, config);

            const executionTime = executionTimer();

            // 根据分析结果回复
            const replyContent = [
                '✅ 分析完成！',
                `📊 总计分析了 ${result.statistics.totalThreads} 个主题`,
                `⚠️ 处理失败: ${result.failedOperations.length} 个`,
                `⏱️ 总执行时间: ${executionTime}秒`
            ].join('\n');

            await interaction.editReply({
                content: replyContent,
                flags: ['Ephemeral']
            });

        } catch (error) {
            console.error('分析执行错误:', error);
            const executionTime = executionTimer();
            await interaction.editReply({
                content: `执行分析时出现错误: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
};