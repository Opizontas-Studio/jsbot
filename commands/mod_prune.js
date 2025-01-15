const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime, generateProgressReport, handleCommandError } = require('../utils/helper');
const { cleanThreadMembers } = require('../utils/cleaner');

/**
 * 清理子区不活跃用户命令
 * 支持单个子区清理和全服清理两种模式
 */
module.exports = {
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
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
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
async function handleSingleThread(interaction, guildConfig) {
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
    if (guildConfig.whitelistedThreads?.includes(thread.id)) {
        await interaction.editReply({
            content: '✅ 此子区在白名单中，已跳过清理。',
            flags: ['Ephemeral']
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
        !guildConfig.whitelistedThreads?.includes(thread.id)
    );

    logTime(`已获取活跃子区列表，共 ${threads.size} 个子区`);
    
    // 获取需要处理的子区
    const threadsToClean = [];
    for (const thread of threads.values()) {
        try {
            const members = await thread.members.fetch();
            if (members.size > threshold) {
                threadsToClean.push(thread);
            }
        } catch (error) {
            logTime(`获取子区 ${thread.name} 成员数失败: ${error.message}`, true);
        }
    }

    if (threadsToClean.length === 0) {
        await interaction.editReply({
            content: '✅ 检查完成，没有发现需要清理的子区。',
            flags: ['Ephemeral']
        });
        return;
    }

    // 处理结果存储
    const results = [];
    let processedCount = 0;

    // 每批处理5个子区
    const batchSize = 5;
    for (let i = 0; i < threadsToClean.length; i += batchSize) {
        const batch = threadsToClean.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (thread) => {
            processedCount++;
            await interaction.editReply({
                content: generateProgressReport(processedCount, threadsToClean.length, `正在处理 - ${thread.name}\n`),
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
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(result => result.status === 'completed'));
    }

    // 发送总结报告
    await sendSummaryReport(interaction, results, threshold, guildConfig);
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
    const moderationChannel = await interaction.client.channels.fetch(interaction.guildConfig.moderationThreadId);
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
    const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
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