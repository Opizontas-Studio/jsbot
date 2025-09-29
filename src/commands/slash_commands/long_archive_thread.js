import { SlashCommandBuilder } from 'discord.js';
import { cleanupInactiveThreads } from '../../services/threadAnalyzer.js';
import { generateProgressReport } from '../../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../../utils/helper.js';

/**
 * 清理命令 - 归档不活跃的子区
 * 当活跃子区数量超过阈值时，自动归档最不活跃的子区
 */
export default {
    cooldown: 30,
    ephemeral: false,
    data: new SlashCommandBuilder()
        .setName('清理活跃贴')
        .setDescription('清理不活跃的子区')
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

        try {
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

            const result = await cleanupInactiveThreads(
                interaction.client,
                guildConfig,
                interaction.guildId,
                threshold,
                activeThreads,
            );

            // 在清理过程中添加进度更新
            const remainingThreads = currentThreadCount - threshold;
            const archivedCount = result.statistics.archivedThreads || 0;

            // 更新进度
            await interaction.editReply({
                content: generateProgressReport(archivedCount, remainingThreads, {
                    prefix: '归档进度',
                    suffix: `目标: ${threshold}个活跃子区`,
                    progressChar: '📦',
                }),
            });

            const executionTime = executionTimer();

            // 构建回复消息
            const replyContent = [
                '✅ 清理操作完成！',
                `📊 当前活跃子区总数: ${result.statistics.totalThreads}`,
                `🧹 已清理子区数: ${result.statistics.archivedThreads || 0}`,
                `📌 已跳过置顶子区: ${result.statistics.skippedPinnedThreads || 0}`,
                `⏱️ 总执行时间: ${executionTime}秒`,
            ].join('\n');

            await interaction.editReply({
                content: replyContent,
            });
        } catch (error) {
            await handleCommandError(interaction, error, '清理子区');
        }
    },
};
