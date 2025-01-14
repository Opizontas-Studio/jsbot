const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { analyzeThreads } = require('../utils/threadAnalyzer');
const config = require('../config.json');
const { checkPermission, handlePermissionResult, measureTime } = require('../utils/common');

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
        const hasPermission = checkPermission(interaction.member, config.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        const threshold = interaction.options.getInteger('threshold');
        const executionTimer = measureTime();

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });

            // 先获取当前活跃主题数量
            const guild = await interaction.client.guilds.fetch(config.guildId);
            const activeThreads = await guild.channels.fetchActiveThreads();
            const currentThreadCount = activeThreads.threads.size;

            // 如果当前活跃主题数已经小于等于阈值，则无需清理
            if (currentThreadCount <= threshold) {
                const executionTime = executionTimer();
                await interaction.editReply({
                    content: [
                        '⚠️ 无需清理！',
                        `📊 当前活跃主题数 (${currentThreadCount}) 已经小于或等于目标阈值 (${threshold})`,
                        `⏱️ 检查用时: ${executionTime}秒`
                    ].join('\n'),
                    flags: ['Ephemeral']
                });
                return;
            }

            // 执行分析和清理
            const result = await analyzeThreads(interaction.client, config, {
                clean: true,
                threshold: threshold
            }, activeThreads);

            const executionTime = executionTimer();

            // 构建回复消息
            const replyContent = [
                '✅ 清理操作完成！',
                `📊 当前活跃主题总数: ${result.statistics.totalThreads}`,
                `🧹 已清理主题数: ${result.statistics.archivedThreads || 0}`,
                `📌 已跳过置顶主题: ${result.statistics.skippedPinnedThreads || 0}`,
                `⏱️ 总执行时间: ${executionTime}秒`
            ].join('\n');

            await interaction.editReply({
                content: replyContent,
                flags: ['Ephemeral']
            });

        } catch (error) {
            console.error('清理执行错误:', error);
            const executionTime = executionTimer();
            await interaction.editReply({
                content: `执行清理时出现错误: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 