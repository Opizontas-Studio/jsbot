import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { analyzeThreads } from '../utils/analyzers.js';
import { checkAndHandlePermission, measureTime, handleCommandError } from '../utils/helper.js';

/**
 * 分析命令 - 生成子区活跃度统计报告
 * 统计所有子区的活跃状态，并在日志频道更新分析报告
 */
export default {
    cooldown: 10, // 设置10秒冷却时间
    data: new SlashCommandBuilder()
        .setName('更新分析报告')
        .setDescription('分析论坛子区活跃度统计')
        .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        if (!await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds)) return;

        const executionTimer = measureTime();

        try {
            // 发送临时响应
            await interaction.deferReply({ flags: ['Ephemeral'] });

            const result = await analyzeThreads(interaction.client, guildConfig, interaction.guildId);
            const executionTime = executionTimer();

            // 根据分析结果回复
            const replyContent = [
                '✅ 分析完成！',
                `📊 总计分析了 ${result.statistics.totalThreads} 个子区`,
                `⚠️ 处理失败: ${result.failedOperations.length} 个`,
                `⏱️ 总执行时间: ${executionTime}秒`
            ].join('\n');

            await interaction.editReply({
                content: replyContent,
                flags: ['Ephemeral']
            });

        } catch (error) {
            await handleCommandError(interaction, error, '更新分析报告');
        }
    },
};