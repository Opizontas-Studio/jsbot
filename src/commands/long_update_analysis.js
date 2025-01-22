import { SlashCommandBuilder } from 'discord.js';
import { analyzeForumActivity } from '../services/analyzers.js';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../utils/helper.js';

/**
 * 分析命令 - 生成子区活跃度统计报告
 * 统计所有子区的活跃状态，并在日志频道更新分析报告
 */
export default {
    cooldown: 10, // 设置10秒冷却时间
    data: new SlashCommandBuilder()
	    .setName('更新分析报告')
	    .setDescription('分析论坛子区活跃度统计'),

    async execute(interaction, guildConfig) {
	    // 检查用户是否有执行权限
	    if (!await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds)) return;

	    const executionTimer = measureTime();

	    try {
	        const result = await analyzeForumActivity(interaction.client, guildConfig, interaction.guildId);
	        const executionTime = executionTimer();

	        // 构建回复消息
	        const replyContent = [
	            '✅ 分析完成！',
	            `📊 活跃子区总数: ${result.statistics.totalThreads}`,
	            `⚠️ 处理异常数: ${result.statistics.processedWithErrors}`,
	            '🕒 不活跃统计:',
	            `- 72小时以上: ${result.statistics.inactiveThreads.over72h}`,
	            `- 48小时以上: ${result.statistics.inactiveThreads.over48h}`,
	            `- 24小时以上: ${result.statistics.inactiveThreads.over24h}`,
	            `⏱️ 执行用时: ${executionTime}秒`,
	        ].join('\n');

	        await interaction.editReply({
	            content: replyContent,
	            flags: ['Ephemeral'],
	        });

	    } catch (error) {
	        await handleCommandError(interaction, error, '更新分析报告');
	    }
    },
};