import { SlashCommandBuilder } from 'discord.js';
import { analyzeFastGPTLogs, createFastGPTStatsEmbed } from '../services/fastgptService.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 3,
    data: new SlashCommandBuilder()
        .setName('答疑系统状态')
        .setDescription('查看当前答疑系统运行状态')
        .addStringOption(option =>
            option
                .setName('日期')
                .setDescription('指定查询日期，格式：2025-04-15，不填则默认为今天')
                .setRequired(false),
        ),

    async execute(interaction, guildConfig) {
        try {
            // 获取可选的日期参数
            const dateStr = interaction.options.getString('日期');
            let targetDate = new Date();

            // 如果提供了日期参数，尝试解析它
            if (dateStr) {
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                if (!dateRegex.test(dateStr)) {
                    return await interaction.reply({
                        content: '⚠️ 日期格式错误，请使用格式：2025-04-15',
                        ephemeral: true,
                    });
                }
                targetDate = new Date(dateStr);

                // 检查日期是否有效
                if (isNaN(targetDate.getTime())) {
                    return await interaction.reply({
                        content: '⚠️ 无效的日期，请使用格式：2025-04-15',
                        ephemeral: true,
                    });
                }
            }

            try {
                const channel = interaction.channel;
                // 使用目标日期分析日志
                const fastgptStats = await analyzeFastGPTLogs(targetDate);

                // 创建FastGPT统计的嵌入消息
                const fastgptEmbed = createFastGPTStatsEmbed(fastgptStats);

                // 发送FastGPT统计信息作为单独的嵌入消息
                await interaction.editReply({
                    content: dateStr ? `✅ ${dateStr} 的统计数据请求成功` : '✅ 今日统计数据请求成功',
                });

                await channel.send({ embeds: [fastgptEmbed] });

                logTime(
                    `用户 ${interaction.user.tag} 查看了${dateStr ? dateStr + ' 的' : '今日'}系统状态和FastGPT统计`,
                );
            } catch (statsError) {
                // 如果统计处理失败，只记录错误，不影响主命令功能
                logTime(`FastGPT统计处理失败: ${statsError.message}`, true);
                await interaction.editReply({
                    content: `⚠️ FastGPT统计信息加载失败: ${statsError.message}`,
                });
            }
        } catch (error) {
            await handleCommandError(interaction, error, '系统状态');
        }
    },
};
