import { SlashCommandBuilder } from 'discord.js';
import { cleanupInactiveThreadsSimple } from '../../services/thread/threadAnalyzer.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { checkAndHandlePermission, measureTime } from '../../utils/helper.js';

/**
 * 清理命令 - 归档不活跃的子区
 * 精简版：仅根据最后消息时间归档，不包含数据同步和报告生成
 */
export default {
    cooldown: 30,
    ephemeral: false,
    data: new SlashCommandBuilder()
        .setName('清理活跃贴')
        .setDescription('清理不活跃的子区（快速模式：仅根据最后消息时间归档）')
        .addIntegerOption(option =>
            option
                .setName('阈值')
                .setDescription('活跃子区数量阈值 (500-1000)')
                .setRequired(true)
                .setMinValue(500)
                .setMaxValue(1000),
        ),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const threshold = interaction.options.getInteger('阈值');
        const executionTimer = measureTime();

        await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                // 获取当前活跃子区数量并检查是否需要清理
                const guild = interaction.guild;
                const activeThreads = await guild.channels.fetchActiveThreads();
                const currentThreadCount = activeThreads.threads.size;

                // 如果当前活跃子区数已经小于等于阈值，则无需清理
                if (currentThreadCount <= threshold) {
                    const executionTime = executionTimer();
                    await interaction.editReply({
                        content: [
                            '⚠️ 无需清理！',
                            `📊 当前活跃子区数 (${currentThreadCount}) 已经小于或等于目标阈值 (${threshold})`,
                            `⏱️ 检查用时: ${executionTime}秒`,
                        ].join('\n'),
                    });
                    return;
                }

                // 使用简化版清理函数（不包含成员数据获取、PG同步、报告生成）
                const result = await cleanupInactiveThreadsSimple(
                    interaction.client,
                    interaction.guildId,
                    threshold,
                    activeThreads,
                );

                const executionTime = executionTimer();

                // 构建回复消息
                const replyContent = [
                    '✅ 快速清理完成！',
                    `📊 处理活跃子区总数: ${result.statistics.totalThreads}`,
                    `🧹 已归档子区数: ${result.statistics.archivedThreads || 0}`,
                    `📌 已跳过置顶子区: ${result.statistics.skippedPinnedThreads || 0}`,
                    result.statistics.processedWithErrors > 0 ? 
                        `⚠️ 处理错误数: ${result.statistics.processedWithErrors}` : '',
                    `⏱️ 总执行时间: ${executionTime}秒`,
                ].filter(line => line).join('\n');

                await interaction.editReply({
                    content: replyContent,
                });
            },
            '清理子区',
            { ephemeral: false }
        );
    },
};
