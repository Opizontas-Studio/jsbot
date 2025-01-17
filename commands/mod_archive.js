import { SlashCommandBuilder } from 'discord.js';
import { analyzeThreads } from '../utils/analyzers.js';
import { checkPermission, handlePermissionResult, measureTime } from '../utils/helper.js';
import { globalRequestQueue } from '../utils/concurrency.js';

/**
 * 清理命令 - 归档不活跃的子区
 * 当活跃子区数量超过阈值时，自动归档最不活跃的子区
 */
export default {
    cooldown: 10, // 设置10秒冷却时间
    data: new SlashCommandBuilder()
        .setName('清理活跃贴')
        .setDescription('清理不活跃的子区')
        .addIntegerOption(option =>
            option.setName('阈值')
                .setDescription('活跃子区数量阈值 (500-1000)')
                .setRequired(true)
                .setMinValue(500)
                .setMaxValue(1000)
        ),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        const threshold = interaction.options.getInteger('阈值');
        const executionTimer = measureTime();

        try {
            // 发送临时响应，避免交互超时
            await interaction.deferReply({ flags: ['Ephemeral'] });

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
                        `⏱️ 检查用时: ${executionTime}秒`
                    ].join('\n'),
                    flags: ['Ephemeral']
                });
                return;
            }

            // 将清理操作加入队列
            const result = await globalRequestQueue.add(async () => {
                return await analyzeThreads(interaction.client, guildConfig, interaction.guildId, {
                    clean: true,
                    threshold: threshold || 960
                }, activeThreads);
            }, 2); // 使用中等优先级，因为这是管理员主动触发的清理操作

            const executionTime = executionTimer();

            // 构建回复消息
            const replyContent = [
                '✅ 清理操作完成！',
                `📊 当前活跃子区总数: ${result.statistics.totalThreads}`,
                `🧹 已清理子区数: ${result.statistics.archivedThreads || 0}`,
                `📌 已跳过置顶子区: ${result.statistics.skippedPinnedThreads || 0}`,
                `⏱️ 总执行时间: ${executionTime}秒`
            ].join('\n');

            await interaction.editReply({
                content: replyContent,
                flags: ['Ephemeral']
            });

        } catch (error) {
            console.error('清理执行错误:', error);
            await interaction.editReply({
                content: `执行清理时出现错误: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 