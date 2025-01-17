import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { checkPermission, handlePermissionResult, logTime, generateProgressReport, handleCommandError } from '../utils/helper.js';
import { cleanThreadMembers } from '../utils/cleaner.js';
import { globalBatchProcessor, globalRateLimiter } from '../utils/concurrency.js';

/**
 * 清理子区不活跃用户命令
 * 支持单个子区清理和全服清理两种模式
 */
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('清理子区不活跃用户')
        .setDescription('清理子区中的不活跃用户')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(subcommand =>
            subcommand
                .setName('当前')
                .setDescription('清理当前子区的不活跃用户')
                .addIntegerOption(option =>
                    option.setName('阈值')
                        .setDescription('目标人数阈值(默认950)')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('全部')
                .setDescription('清理所有超过阈值的子区')
                .addIntegerOption(option =>
                    option.setName('阈值')
                        .setDescription('目标人数阈值(默认980)')
                        .setMinValue(900)
                        .setMaxValue(1000)
                        .setRequired(false))),

    async execute(interaction, guildConfig) {
        const hasPermission = checkPermission(interaction.member, guildConfig.AdministratorRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        const subcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: ['Ephemeral'] });

        try {
            if (subcommand === '当前') {
                await handleSingleThread(interaction, guildConfig);
            } else if (subcommand === '全部') {
                await handleAllThreads(interaction, guildConfig);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '清理子区不活跃用户');
        }
    },

    handleSingleThread
};

/**
 * 处理单个子区的清理
 */
export async function handleSingleThread(interaction, guildConfig) {
    if (!interaction.channel.isThread()) {
        await interaction.editReply({
            content: '❌ 此命令只能在子区中使用',
            flags: ['Ephemeral']
        });
        return;
    }

    const thread = interaction.channel;
    const threshold = interaction.options.getInteger('阈值') || 950;

    // 检查白名单
    if (guildConfig.automation.whitelistedThreads?.includes(thread.id)) {
        await interaction.editReply({
            content: '✅ 此子区在白名单中，已跳过清理。',
            flags: ['Ephemeral']
        });
        return;
    }

    // 提前检查成员数量
    const members = await thread.members.fetch();
    const memberCount = members.size;
    
    if (memberCount < threshold) {
        await interaction.editReply({
            embeds: [{
                color: 0x808080,
                title: '❌ 无需清理',
                description: `当前子区人数(${memberCount})未达到清理阈值(${threshold})`
            }]
        });
        return;
    }

    const result = await cleanThreadMembers(
        thread,
        threshold,
        { sendThreadReport: true },
        (progress) => updateProgress(interaction, progress)
    );

    await handleCleanupResult(interaction, result, threshold);
}

/**
 * 处理全服子区的清理
 */
async function handleAllThreads(interaction, guildConfig) {
    const threshold = interaction.options.getInteger('阈值') || 980;
    logTime(`开始执行全服清理，阈值: ${threshold}`);
    
    const activeThreads = await interaction.guild.channels.fetchActiveThreads();
    const threads = activeThreads.threads.filter(thread => 
        !guildConfig.automation.whitelistedThreads?.includes(thread.id)
    );

    logTime(`已获取活跃子区列表，共 ${threads.size} 个子区`);
    
    await interaction.editReply({
        content: '⏳ 正在检查所有子区人数...',
        flags: ['Ephemeral']
    });

    // 使用Map存储结果
    const threadStats = new Map();
    let skippedCount = 0;

    try {
        // 使用批处理器处理子区检查
        const results = await globalBatchProcessor.processBatch(
            Array.from(threads.values()),
            async (thread) => {
                try {
                    // 使用速率限制器包装API调用
                    return await globalRateLimiter.withRateLimit(async () => {
                        const members = await thread.members.fetch();
                        return {
                            thread,
                            memberCount: members.size,
                            needsCleanup: members.size > threshold
                        };
                    });
                } catch (error) {
                    logTime(`获取子区 ${thread.name} 成员数失败: ${error.message}`, true);
                    return null;
                }
            },
            async (progress, processed, total) => {
                // 更新进度显示
                await interaction.editReply({
                    content: `⏳ 正在检查子区人数... (${processed}/${total})`,
                    flags: ['Ephemeral']
                });
            },
            'threadCheck'  // 指定任务类型为子区检查
        );

        // 处理结果
        const threadsToClean = [];
        for (const result of results) {
            if (result && result.needsCleanup) {
                threadsToClean.push(result);
            } else if (result) {
                skippedCount++;
            }
        }

        if (threadsToClean.length === 0) {
            await interaction.editReply({
                content: [
                    '✅ 检查完成，没有发现需要清理的子区',
                    `📊 已检查: ${threads.size} 个子区`,
                    `⏭️ 已跳过: ${skippedCount} 个子区(人数未超限)`
                ].join('\n'),
                flags: ['Ephemeral']
            });
            return;
        }

        // 显示待处理列表
        await interaction.editReply({
            embeds: [{
                color: 0xff9900,
                title: '🔍 子区清理检查结果',
                description: [
                    `共发现 ${threadsToClean.length} 个需要清理的子区:`,
                    '',
                    ...threadsToClean.map(({ thread, memberCount }) => 
                        `• ${thread.name}: ${memberCount}人 (需清理${memberCount - threshold}人)`
                    ),
                    '',
                    '即将开始清理...'
                ].join('\n')
            }],
            flags: ['Ephemeral']
        });

        // 处理结果存储
        const cleanupResults = [];

        // 使用 BatchProcessor 处理子区清理
        const cleanupBatchResults = await globalBatchProcessor.processBatch(
            threadsToClean,
            async ({ thread }) => {
                await interaction.editReply({
                    content: generateProgressReport(cleanupResults.length + 1, threadsToClean.length, `正在处理 - ${thread.name}\n`),
                    flags: ['Ephemeral']
                });

                return await cleanThreadMembers(
                    thread,
                    threshold,
                    { sendThreadReport: true },
                    (progress) => {
                        if (progress.type === 'message_scan' && progress.messagesProcessed % 1000 === 0) {
                            logTime(`[${thread.name}] 已处理 ${progress.messagesProcessed} 条消息`);
                        } else if (progress.type === 'member_remove' && progress.batchCount % 5 === 0) {
                            logTime(`[${thread.name}] 已移除 ${progress.removedCount}/${progress.totalToRemove} 个成员`);
                        }
                    }
                );
            },
            async (progress, processed, total) => {
                if (processed % 5 === 0) {
                    logTime(`已完成 ${processed}/${total} 个子区的清理`);
                }
            },
            'memberRemove'  // 使用较小批次处理子区清理
        );

        cleanupResults.push(...cleanupBatchResults.filter(result => result.status === 'completed'));

        // 发送总结报告
        await sendSummaryReport(interaction, cleanupResults, threshold, guildConfig);

    } catch (error) {
        logTime(`执行全服清理时出错: ${error.message}`, true);
        throw error;
    }
}

/**
 * 更新进度显示
 */
async function updateProgress(interaction, progress) {
    if (progress.type === 'message_scan') {
        await interaction.editReply({
            content: generateProgressReport(progress.messagesProcessed, progress.totalMessages, '正在统计活跃用户...'),
            flags: ['Ephemeral']
        });
    } else if (progress.type === 'member_remove') {
        await interaction.editReply({
            content: generateProgressReport(progress.removedCount, progress.totalToRemove, '正在移除未发言成员...'),
            flags: ['Ephemeral']
        });
    }
}

/**
 * 处理清理结果
 */
async function handleCleanupResult(interaction, result, threshold) {
    if (result.status === 'skipped') {
        const message = result.reason === 'whitelisted' 
            ? '✅ 此子区在白名单中，已跳过清理。'
            : `✅ 当前子区人数(${result.memberCount})已经在限制范围内，无需清理。`;
            
        await interaction.editReply({
            content: message,
            flags: ['Ephemeral']
        });
        return;
    }

    if (result.status === 'error') {
        throw new Error(result.error);
    }

    // 发送操作日志
    const moderationChannel = await interaction.client.channels.fetch(interaction.guildConfig.moderationLogThreadId);
    await moderationChannel.send({
        embeds: [{
            color: 0x0099ff,
            title: '子区清理报告',
            fields: [{
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
            }],
            timestamp: new Date(),
            footer: { text: '论坛管理系统' }
        }]
    });

    // 回复执行结果
    await interaction.editReply({
        content: [
            '✅ 子区清理完成！',
            `🎯 目标阈值: ${threshold}`,
            `📊 原始人数: ${result.originalCount}`,
            `👥 活跃用户: ${result.originalCount - result.inactiveCount}`,
            `🚫 已移除: ${result.removedCount}`,
            `👤 当前人数: ${result.originalCount - result.removedCount}`
        ].join('\n'),
        flags: ['Ephemeral']
    });
}

/**
 * 发送全服清理总结报告
 */
async function sendSummaryReport(interaction, results, threshold, guildConfig) {
    // 发送管理日志
    const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationLogThreadId);
    await moderationChannel.send({
        embeds: [{
            color: 0x0099ff,
            title: '全服子区清理报告',
            description: `已完成所有超过 ${threshold} 人的子区清理：`,
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
            footer: { text: '论坛管理系统' }
        }]
    });

    // 计算总结数据
    const summary = results.reduce((acc, curr) => ({
        totalOriginal: acc.totalOriginal + curr.originalCount,
        totalRemoved: acc.totalRemoved + curr.removedCount
    }), { totalOriginal: 0, totalRemoved: 0 });

    // 发送执行结果
    await interaction.editReply({
        content: [
            '✅ 全服子区清理完成！',
            `🎯 目标阈值: ${threshold}`,
            `📊 处理子区数: ${results.length}`,
            `👥 原始总人数: ${summary.totalOriginal}`,
            `🚫 总移除人数: ${summary.totalRemoved}`
        ].join('\n'),
        flags: ['Ephemeral']
    });
} 