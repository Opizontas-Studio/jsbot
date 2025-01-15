const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime } = require('../utils/common');
const { cleanThreadMembers } = require('../utils/threadCleaner');

/**
 * 重整命令 - 清理子区未发言成员
 * 将子区人数控制在750以下，优先移除未发言成员
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('重整人数')
        .setDescription('清理子区未发言成员，控制人数在指定阈值以下')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option =>
            option.setName('阈值')
                .setDescription('目标人数阈值(默认950)')
                .setMinValue(800)
                .setMaxValue(1000)
                .setRequired(false)),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        // 验证当前频道是否为论坛帖子
        if (!interaction.channel.isThread()) {
            await interaction.reply({
                content: '❌ 此命令只能在帖子中使用',
                flags: ['Ephemeral']
            });
            return;
        }

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            const thread = interaction.channel;
            const threshold = interaction.options.getInteger('阈值') || 950;

            const result = await cleanThreadMembers(
                thread,
                threshold,
                { sendThreadReport: true },
                async (progress) => {
                    if (progress.type === 'message_scan') {
                        await interaction.editReply({
                            content: `正在统计活跃用户...已处理 ${progress.messagesProcessed} 条消息`,
                            flags: ['Ephemeral']
                        });
                    } else if (progress.type === 'member_remove') {
                        await interaction.editReply({
                            content: `正在移除未发言成员...${progress.removedCount}/${progress.totalToRemove}`,
                            flags: ['Ephemeral']
                        });
                    }
                }
            );

            if (result.status === 'skipped') {
                await interaction.editReply({
                    content: `✅ 当前子区人数(${result.memberCount})已经在限制范围内，无需重整。`,
                    flags: ['Ephemeral']
                });
                return;
            }

            if (result.status === 'error') {
                throw new Error(result.error);
            }

            // 发送操作日志到管理频道
            await sendCleanupReport(interaction, guildConfig, result);

            // 完成回复
            await interaction.editReply({
                content: [
                    '✅ 子区人数重整完成！',
                    `🎯 目标阈值: ${threshold}`,
                    `📊 原始人数: ${result.originalCount}`,
                    `👥 活跃用户: ${result.originalCount - result.inactiveCount}`,
                    `🚫 已移除: ${result.removedCount}`,
                    `👤 当前人数: ${result.originalCount - result.removedCount}`
                ].join('\n'),
                flags: ['Ephemeral']
            });

        } catch (error) {
            logTime(`重整子区人数时出错: ${error}`, true);
            await interaction.editReply({
                content: `❌ 执行重整时出错: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 