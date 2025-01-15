const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime } = require('../utils/common');
const { cleanThreadMembers } = require('../utils/threadCleaner');

/**
 * 全服重整命令 - 清理所有超限子区的未发言成员
 * 扫描所有活跃子区，对超过指定人数的子区进行人数重整
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('全服重整')
        .setDescription('清理所有超过指定人数的子区')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option =>
            option.setName('阈值')
                .setDescription('目标人数阈值(默认980)')
                .setMinValue(900)
                .setMaxValue(1000)
                .setRequired(false)),

    async execute(interaction, guildConfig) {
        // 检查权限
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            logTime('开始执行全服重整...');
            
            // 获取阈值参数
            const threshold = interaction.options.getInteger('阈值') || 980;
            logTime(`清理阈值设置为: ${threshold}`);
            
            // 获取所有活跃子区
            const activeThreads = await interaction.guild.channels.fetchActiveThreads();
            const threads = activeThreads.threads;
            logTime(`已获取活跃子区列表，共 ${threads.size} 个子区`);
            
            // 并行获取所有子区的成员数量
            logTime('开始检查各子区成员数量...');
            const memberCountPromises = Array.from(threads.values()).map(async thread => {
                try {
                    const members = await thread.members.fetch();
                    return {
                        thread,
                        memberCount: members.size
                    };
                } catch (error) {
                    logTime(`获取子区 ${thread.name} 成员数失败: ${error.message}`, true);
                    return null;
                }
            });

            const memberCounts = (await Promise.all(memberCountPromises))
                .filter(result => result && result.memberCount > threshold);
            
            logTime(`检查完成，发现 ${memberCounts.length} 个超过 ${threshold} 人的子区`);

            if (memberCounts.length === 0) {
                await interaction.editReply({
                    content: `✅ 检查完成，没有发现超过 ${threshold} 人的子区。`,
                    flags: ['Ephemeral']
                });
                return;
            }

            // 处理结果存储
            const results = [];
            let processedCount = 0;

            // 并行处理子区，每批5个
            const batchSize = 5;
            for (let i = 0; i < memberCounts.length; i += batchSize) {
                const batch = memberCounts.slice(i, i + batchSize);
                logTime(`开始处理第 ${i/batchSize + 1} 批子区 (${batch.length} 个)`);
                
                const batchPromises = batch.map(async ({ thread }) => {
                    processedCount++;
                    logTime(`[${thread.name}] 开始处理...`);

                    await interaction.editReply({
                        content: `正在处理 ${processedCount}/${memberCounts.length} - ${thread.name}`,
                        flags: ['Ephemeral']
                    });

                    return await cleanThreadMembers(
                        thread,
                        threshold,
                        { sendThreadReport: true },
                        (progress) => {
                            if (progress.type === 'message_scan') {
                                logTime(`[${thread.name}] 已处理 ${progress.messagesProcessed} 条消息`);
                            } else if (progress.type === 'member_remove' && progress.batchCount % 5 === 0) {
                                logTime(`[${thread.name}] 已移除 ${progress.removedCount}/${progress.totalToRemove} 个成员`);
                            }
                        }
                    );
                });

                const batchResults = await Promise.all(batchPromises);
                const validResults = batchResults.filter(result => result.status === 'completed');
                results.push(...validResults);
                
                logTime(`第 ${i/batchSize + 1} 批处理完成，成功: ${validResults.length}/${batch.length}`);
            }

            logTime('所有子区处理完成，准备发送报告...');

            // 发送操作日志到管理频道
            const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
            await moderationChannel.send({
                embeds: [{
                    color: 0x0099ff,
                    title: '全服子区人数重整报告',
                    description: `已完成所有超过 ${threshold} 人的子区重整：`,
                    fields: results.map(result => ({
                        name: result.name,
                        value: [
                            `[跳转到子区](${result.url})`,
                            `原始人数: ${result.originalCount}`,
                            `移除人数: ${result.removedCount}`,
                            `当前人数: ${result.originalCount - result.removedCount}`,
                            result.lowActivityCount > 0 ? 
                                `(包含 ${result.lowActivityCount} 个低活跃度成员)` : 
                                ''
                        ].filter(Boolean).join('\n'),
                        inline: false
                    })),
                    timestamp: new Date(),
                    footer: {
                        text: '论坛管理系统'
                    }
                }]
            });

            // 完成回复
            const summary = results.reduce((acc, curr) => ({
                totalOriginal: acc.totalOriginal + curr.originalCount,
                totalRemoved: acc.totalRemoved + curr.removedCount
            }), { totalOriginal: 0, totalRemoved: 0 });

            await interaction.editReply({
                content: [
                    '✅ 全服子区人数重整完成！',
                    `🎯 目标阈值: ${threshold}`,
                    `📊 处理子区数: ${results.length}`,
                    `👥 原始总人数: ${summary.totalOriginal}`,
                    `🚫 总移除人数: ${summary.totalRemoved}`
                ].join('\n'),
                flags: ['Ephemeral']
            });

        } catch (error) {
            logTime(`全服重整出错: ${error}`, true);
            await interaction.editReply({
                content: `❌ 执行全服重整时出错: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 