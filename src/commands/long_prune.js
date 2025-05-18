import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { cleanThreadMembers } from '../services/threadCleaner.js';
import { generateProgressReport, globalBatchProcessor } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

/**
 * 清理子区不活跃用户命令
 * 支持单个子区清理和全服清理两种模式
 */
export default {
    cooldown: 30,
    ephemeral: false,
    data: new SlashCommandBuilder()
        .setName('清理子区不活跃用户')
        .setDescription('清理子区中的不活跃用户')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(subcommand =>
            subcommand
                .setName('当前')
                .setDescription('清理当前子区的不活跃用户')
                .addIntegerOption(option =>
                    option
                        .setName('阈值')
                        .setDescription('目标人数阈值(默认950)')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('全部')
                .setDescription('清理所有超过阈值的子区')
                .addIntegerOption(option =>
                    option
                        .setName('阈值')
                        .setDescription('目标人数阈值(默认980)')
                        .setMinValue(900)
                        .setMaxValue(1000)
                        .setRequired(false),
                ),
        ),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === '当前') {
                await handleSingleThreadCleanup(interaction, guildConfig);
            } else if (subcommand === '全部') {
                await handleAllThreads(interaction, guildConfig);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '清理子区不活跃用户');
        }
    },
};

/**
 * 处理全服子区的清理
 */
async function handleAllThreads(interaction, guildConfig) {
    const threshold = interaction.options.getInteger('阈值') || 980;
    logTime(`开始执行全服清理，阈值: ${threshold}`);

    const activeThreads = await interaction.guild.channels.fetchActiveThreads();
    const threads = activeThreads.threads.filter(
        thread => !guildConfig.automation.whitelistedThreads?.includes(thread.id),
    );

    logTime(`已获取活跃子区列表，共 ${threads.size} 个子区`);

    await interaction.editReply({
        content: '⏳ 正在检查所有子区人数...',
        flags: ['Ephemeral'],
    });

    let skippedCount = 0;
    let lastProgressUpdate = Date.now();

    try {
        // 使用批处理器处理子区检查，每批次处理3个子区
        const batchSize = 3;
        const threadArray = Array.from(threads.values());
        const batches = [];

        for (let i = 0; i < threadArray.length; i += batchSize) {
            batches.push(threadArray.slice(i, i + batchSize));
        }

        const results = [];
        let processedCount = 0;

        // 并发处理每个批次
        await Promise.all(
            batches.map(async batch => {
                const batchResults = await globalBatchProcessor.processBatch(
                    batch,
                    async thread => {
                        try {
                            const members = await thread.members.fetch();
                            return {
                                thread,
                                memberCount: members.size,
                                needsCleanup: members.size > threshold,
                            };
                        } catch (error) {
                            logTime(`获取子区 ${thread.name} 成员数失败: ${error.message}`, true);
                            return null;
                        }
                    },
                    null, // 移除每个子任务的进度回调
                    'threadCheck',
                );

                // 更新进度
                processedCount += batch.length;
                const now = Date.now();
                if (now - lastProgressUpdate > 1000) {
                    // 限制进度更新频率为1秒
                    lastProgressUpdate = now;
                    await interaction.editReply({
                        content: `⏳ 正在检查子区人数... (${processedCount}/${threads.size})`,
                    });
                }

                results.push(...batchResults);
            }),
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
                    `⏭️ 已跳过: ${skippedCount} 个子区(人数未超限)`,
                ].join('\n'),
            });
            return;
        }

        // 构建需要清理的子区信息摘要
        const threadsInfo = threadsToClean.map(
            ({ thread, memberCount }) =>
                `• ${thread.name}: ${memberCount}人 (需清理${memberCount - threshold}人)`
        ).join('\n');

        // 使用确认按钮让管理员确认是否执行清理
        await handleConfirmationButton({
            interaction,
            customId: 'confirm_clean_all_threads',
            buttonLabel: '确认清理',
            embed: {
                color: 0xff9900,
                title: '🔍 子区清理确认',
                description: [
                    `共发现 ${threadsToClean.length} 个需要清理的子区:`,
                    '',
                    threadsInfo,
                    '',
                    `⚠️ **警告**: 此操作将从上述子区移除不活跃成员。`,
                    `清理阈值: ${threshold}人`,
                    `总计清理人数: ${threadsToClean.reduce((sum, { memberCount }) => sum + (memberCount - threshold), 0)}人`,
                ].join('\n'),
                footer: { text: '请确认是否执行清理操作' }
            },
            onConfirm: async confirmation => {
                await confirmation.update({
                    content: '⏳ 已确认，开始执行清理操作...',
                    components: [],
                    embeds: [],
                });

                // 处理结果存储
                const cleanupResults = [];

                // 使用批处理器处理子区清理
                const cleanupBatchResults = await globalBatchProcessor.processBatch(
                    threadsToClean,
                    async ({ thread }) => {
                        await interaction.editReply({
                            content: generateProgressReport(cleanupResults.length + 1, threadsToClean.length, {
                                prefix: '正在处理子区清理',
                                suffix: `- ${thread.name}`,
                                progressChar: '🔄',
                            }),
                        });

                        return await cleanThreadMembers(thread, threshold, { sendThreadReport: true }, progress => {
                            if (progress.type === 'message_scan' && progress.messagesProcessed % 1000 === 0) {
                                logTime(`[${thread.name}] 已处理 ${progress.messagesProcessed} 条消息`);
                            } else if (progress.type === 'member_remove' && progress.batchCount % 5 === 0) {
                                logTime(`[${thread.name}] 已移除 ${progress.removedCount}/${progress.totalToRemove} 个成员`);
                            }
                        });
                    },
                    async (progress, processed, total) => {
                        if (processed % 5 === 0) {
                            logTime(`已完成 ${processed}/${total} 个子区的清理`);
                        }
                    },
                    'memberRemove', // 使用较小批次处理子区清理
                );

                cleanupResults.push(...cleanupBatchResults.filter(result => result.status === 'completed'));

                // 发送总结报告
                await sendSummaryReport(interaction, cleanupResults, threshold, guildConfig);
            },
            onTimeout: async () => {
                await interaction.editReply({
                    content: '⏱️ 确认超时，操作已取消',
                    components: [],
                    embeds: [],
                });
            },
            onError: async error => {
                await handleCommandError(interaction, error, '全服清理确认');
            },
        });
    } catch (error) {
        await handleCommandError(interaction, error, '全服清理');
    }
}

/**
 * 发送全服清理总结报告
 */
async function sendSummaryReport(interaction, results, threshold, guildConfig) {
    // 发送自动化日志
    const logChannel = await interaction.client.channels.fetch(guildConfig.automation.logThreadId);
    await logChannel.send({
        embeds: [
            {
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
                        result.lowActivityCount > 0 ? `(包含 ${result.lowActivityCount} 个低活跃度成员)` : '',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                    inline: false,
                })),
                timestamp: new Date(),
                footer: { text: '论坛自动化系统' },
            },
        ],
    });

    // 计算总结数据
    const summary = results.reduce(
        (acc, curr) => ({
            totalOriginal: acc.totalOriginal + curr.originalCount,
            totalRemoved: acc.totalRemoved + curr.removedCount,
        }),
        { totalOriginal: 0, totalRemoved: 0 },
    );

    // 发送执行结果
    await interaction.editReply({
        content: [
            '✅ 全服子区清理完成！',
            `📊 目标阈值: ${threshold}`,
            `📊 处理子区数: ${results.length}`,
            `👥 原始总人数: ${summary.totalOriginal}`,
            `🚫 总移除人数: ${summary.totalRemoved}`,
        ].join('\n'),
        flags: ['Ephemeral'],
    });
}

/**
 * 特殊处理单个子区的后台清理
 * 此方法不更新交互，而是直接在后台运行并记录日志
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} thread - 子区对象
 * @param {number} threshold - 目标人数阈值
 * @param {Object} guildConfig - 服务器配置
 */
async function handleBackgroundThreadCleanup(interaction, thread, threshold, guildConfig) {
    try {
        logTime(`[${thread.name}] 开始后台清理任务，阈值: ${threshold}`);

        // 检查白名单
        if (guildConfig.automation.whitelistedThreads?.includes(thread.id)) {
            logTime(`[${thread.name}] 此子区在白名单中，已跳过清理`);
            return;
        }

        // 获取成员数量
        const members = await thread.members.fetch();
        const memberCount = members.size;

        if (memberCount <= threshold) {
            logTime(`[${thread.name}] 当前子区人数(${memberCount})未达到清理阈值(${threshold})，无需清理`);
            return;
        }

        // 用于计数消息处理进度
        let messageCounter = 0;

        // 执行清理任务
        const result = await cleanThreadMembers(thread, threshold, { sendThreadReport: true }, progress => {
            if (progress.type === 'message_scan') {
                messageCounter = progress.messagesProcessed;
                // 每处理5000条消息记录一次进度
                if (messageCounter % 5000 === 0) {
                    logTime(`[${thread.name}] 正在统计消息历史... (已处理 ${messageCounter} 条消息)`);
                }
            } else if (progress.type === 'member_remove' && progress.batchCount % 5 === 0) {
                logTime(`[${thread.name}] 正在移除未发言成员... (${progress.removedCount}/${progress.totalToRemove})`);
            }
        });

        // 记录清理完成
        logTime(`[${thread.name}] 子区清理完成！原始人数: ${result.originalCount}, 移除人数: ${result.removedCount}, 当前人数: ${result.originalCount - result.removedCount}`);

        // 发送自动化日志
        const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
        await logChannel.send({
            embeds: [
                {
                    color: 0x0099ff,
                    title: '子区清理报告',
                    fields: [
                        {
                            name: result.name,
                            value: [
                                `[跳转到子区](${result.url})`,
                                `原始人数: ${result.originalCount}`,
                                `移除人数: ${result.removedCount}`,
                                `当前人数: ${result.originalCount - result.removedCount}`,
                                result.lowActivityCount > 0 ? `(包含 ${result.lowActivityCount} 个低活跃度成员)` : '',
                            ]
                                .filter(Boolean)
                                .join('\n'),
                            inline: false,
                        },
                    ],
                    timestamp: new Date(),
                    footer: { text: '论坛管理系统' },
                },
            ],
        });

        // 发送子区通知
        await thread.send({
            embeds: [
                {
                    color: 0x00ff00,
                    title: '✅ 子区清理完成',
                    description: [
                        `🎯 目标阈值: ${threshold}`,
                        `📊 原始人数: ${result.originalCount}`,
                        `👥 活跃用户: ${result.originalCount - result.inactiveCount}`,
                        `🚫 已移除: ${result.removedCount}`,
                        `👤 当前人数: ${result.originalCount - result.removedCount}`,
                    ].join('\n'),
                    timestamp: new Date(),
                },
            ],
        });

    } catch (error) {
        logTime(`[${thread.name}] 后台清理任务出错: ${error.message}`, true);
    }
}

/**
 * 处理单个子区的清理
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} guildConfig - 服务器配置
 * @returns {Promise<void>}
 */
export async function handleSingleThreadCleanup(interaction, guildConfig) {
    if (!interaction.channel.isThread()) {
        await interaction.editReply({
            content: '❌ 此命令只能在子区中使用',
            flags: ['Ephemeral'],
        });
        return;
    }

    const thread = interaction.channel;
    const threshold = interaction.options.getInteger('阈值') || 950;

    // 检查白名单
    if (guildConfig.automation.whitelistedThreads?.includes(thread.id)) {
        await interaction.editReply({
            content: '✅ 此子区在白名单中，已跳过清理。',
            flags: ['Ephemeral'],
        });
        return;
    }

    // 提前检查成员数量
    const members = await thread.members.fetch();
    const memberCount = members.size;

    if (memberCount < threshold) {
        await interaction.editReply({
            embeds: [
                {
                    color: 0x808080,
                    title: '❌ 无需清理',
                    description: `当前子区人数(${memberCount})未达到清理阈值(${threshold})`,
                },
            ],
        });
        return;
    }

    // 立即返回命令已开始执行
    await interaction.editReply({
        embeds: [
            {
                color: 0x0099ff,
                title: '🚀 子区清理任务已启动',
                description: [
                    `已开始清理子区: ${thread.name}`,
                    `当前人数: ${memberCount}`,
                    `目标阈值: ${threshold}`,
                    '',
                    '⏳ 此任务将在后台执行，完成后会自动发送报告',
                    '请勿重复执行此命令'
                ].join('\n'),
                timestamp: new Date(),
            },
        ],
    });

    // 在后台执行清理任务
    setTimeout(() => {
        handleBackgroundThreadCleanup(interaction, thread, threshold, guildConfig).catch(error => {
            logTime(`后台清理任务启动失败: ${error.message}`, true);
        });
    }, 100);
}
