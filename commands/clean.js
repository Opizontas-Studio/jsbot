const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { analyzeThreads } = require('../utils/threadAnalyzer');
const config = require('../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clean')
        .setDescription('清理不活跃的主题')
        .addIntegerOption(option =>
            option.setName('threshold')
                .setDescription('活跃主题数量阈值 (750-950)')
                .setRequired(true)
                .setMinValue(750)
                .setMaxValue(950)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads),

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

        const threshold = interaction.options.getInteger('threshold');

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });

            // 执行分析和清理
            const result = await analyzeThreads(interaction.client, config, {
                clean: true,
                threshold: threshold
            });

            // 构建回复消息
            const replyContent = [
                '✅ 清理操作完成！',
                `📊 当前活跃主题总数: ${result.statistics.totalThreads}`,
                `🧹 已清理主题数: ${result.statistics.archivedThreads || 0}`,
                `📌 已跳过置顶主题: ${result.statistics.skippedPinnedThreads || 0}`,
                '',
                '详细报告已发送至指定频道。'
            ].join('\n');

            await interaction.editReply({
                content: replyContent
            });

        } catch (error) {
            console.error('清理执行错误:', error);
            await interaction.editReply({
                content: `执行清理时出现错误: ${error.message}`,
                ephemeral: true
            });
        }
    },
}; 