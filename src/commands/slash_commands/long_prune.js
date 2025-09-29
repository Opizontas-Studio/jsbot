import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { cleanThreadMembers, cleanupCachedThreadsSequentially, sendLogReport, updateThreadAutoCleanupSetting } from '../../services/threadCleaner.js';
import { globalRequestQueue } from '../../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

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
                )
                .addBooleanOption(option =>
                    option
                        .setName('启用自动清理')
                        .setDescription('是否启用自动清理功能（默认为是）')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('全部')
                .setDescription('检查并清理所有达到1000人的已缓存子区(使用继承阈值)'),
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
 * 使用类似定时任务的逻辑：检查已缓存子区中达到1000人的进行清理
 */
async function handleAllThreads(interaction, guildConfig) {
    logTime(`开始执行全服缓存子区清理检查`);

    await interaction.editReply({
        content: '⏳ 正在获取活跃子区列表和缓存信息...',
        flags: ['Ephemeral'],
    });

    try {
        // 获取活跃子区列表
        const activeThreads = await interaction.guild.channels.fetchActiveThreads();
        const threads = activeThreads.threads.filter(
            thread => !guildConfig.automation.whitelistedThreads?.includes(thread.id),
        );

        logTime(`已获取活跃子区列表，共 ${threads.size} 个子区`);

        // 创建活跃子区映射表
        const activeThreadsMap = new Map();
        threads.forEach(thread => {
            activeThreadsMap.set(thread.id, thread);
        });

        await interaction.editReply({
            content: '⏳ 正在检查已缓存子区的人数状态...',
        });

        // 执行缓存子区的清理检查（类似定时任务逻辑）
        const cleanupResults = await cleanupCachedThreadsSequentially(
            interaction.client,
            interaction.guildId,
            activeThreadsMap
        );

        // 根据结果显示不同的信息
        if (cleanupResults.totalChecked === 0) {
            await interaction.editReply({
                content: [
                    '✅ 检查完成',
                    '📊 在活跃子区中未发现任何已缓存的子区',
                    '💡 只有执行过清理的子区才会被纳入检查范围',
                ].join('\n'),
            });
            return;
        }

        if (cleanupResults.qualifiedThreads === 0) {
            await interaction.editReply({
                content: [
                    '✅ 检查完成，没有发现需要清理的子区',
                    `📊 已检查缓存子区: ${cleanupResults.totalChecked} 个`,
                    `💡 所有已缓存子区人数均未达到1000人清理阈值`,
                ].join('\n'),
            });
            return;
        }

        // 构建清理结果信息
        const successDetails = cleanupResults.details
            .filter(detail => detail.status === 'success')
            .map(detail =>
                `• ${detail.threadName}: 原${detail.originalCount}人 → 现${detail.originalCount - detail.removedCount}人 (移除${detail.removedCount}人)`
            ).join('\n');

        const errorDetails = cleanupResults.errors.length > 0
            ? cleanupResults.errors
                .slice(0, 5) // 最多显示5个错误
                .map(error => `• ${error.threadName}: ${error.error}`)
                .join('\n')
            : '';

        // 发送总结报告到自动化日志频道
        const logChannel = await interaction.client.channels.fetch(guildConfig.automation.logThreadId);
        await logChannel.send({
            embeds: [
                {
                    color: 0x0099ff,
                    title: '管理员触发的缓存子区清理报告',
                    description: '基于缓存数据的智能清理结果：',
                    fields: [
                        {
                            name: '📊 清理统计',
                            value: [
                                `已检查缓存子区: ${cleanupResults.totalChecked}`,
                                `符合条件子区: ${cleanupResults.qualifiedThreads}`,
                                `成功清理子区: ${cleanupResults.cleanedThreads}`,
                                `清理失败子区: ${cleanupResults.errors.length}`,
                            ].join('\n'),
                            inline: false,
                        },
                        ...(successDetails ? [{
                            name: '✅ 成功清理的子区',
                            value: successDetails,
                            inline: false,
                        }] : []),
                        ...(errorDetails ? [{
                            name: '❌ 清理失败的子区',
                            value: errorDetails + (cleanupResults.errors.length > 5 ? `\n... 以及其他 ${cleanupResults.errors.length - 5} 个错误` : ''),
                            inline: false,
                        }] : []),
                    ],
                    timestamp: new Date(),
                    footer: { text: `执行者: ${interaction.user.tag}` },
                },
            ],
        });

        // 发送执行结果给管理员
        await interaction.editReply({
            content: [
                '✅ 全服缓存子区清理完成！',
                '',
                '📊 **执行统计:**',
                `• 已检查缓存子区: ${cleanupResults.totalChecked}个`,
                `• 符合1000人条件: ${cleanupResults.qualifiedThreads}个`,
                `• 成功清理子区: ${cleanupResults.cleanedThreads}个`,
                `• 清理失败子区: ${cleanupResults.errors.length}个`,
                '',
                '💡 **说明:**',
                '• 此清理基于已缓存的子区数据，使用继承的个性化阈值',
                '• 只有达到1000人的已缓存子区才会被清理',
                '• 详细清理报告已发送到自动化日志频道',
            ].join('\n'),
            flags: ['Ephemeral'],
        });

        logTime(`[管理员全服清理] ${interaction.user.tag} 完成缓存子区清理 - 检查: ${cleanupResults.totalChecked}, 清理: ${cleanupResults.cleanedThreads}, 错误: ${cleanupResults.errors.length}`);

    } catch (error) {
        await handleCommandError(interaction, error, '全服缓存子区清理');
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
    const enableAutoCleanup = interaction.options.getBoolean('启用自动清理') ?? true; // 默认为true

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

    // 检查阈值是否大于990
    if (threshold > 990) {
        await interaction.editReply({
            embeds: [
                {
                    color: 0xffa500,
                    title: '⚠️ 阈值提醒',
                    description: [
                        `当前子区人数: ${memberCount}`,
                        `设定阈值: ${threshold}`,
                        '',
                        '**注意：阈值大于990不会应用到自动清理配置中**',
                        '自动清理仅在子区达到990人时触发，使用的阈值不会超过990',
                        '',
                        `**🤖 自动清理设置：${enableAutoCleanup ? '启用' : '禁用'}**`,
                        enableAutoCleanup
                            ? '• 系统将在子区达到990人时自动清理'
                            : '• 系统将不会对此子区进行自动清理',
                    ].join('\n'),
                },
            ],
            flags: ['Ephemeral'],
        });

        // 更新自动清理设置（但不保存大于990的阈值）
        await updateThreadAutoCleanupSetting(thread.id, {
            enableAutoCleanup: enableAutoCleanup
            // 不保存 manualThreshold，因为它大于990
        });
        return;
    }

    if (memberCount < threshold) {
        // 更新自动清理设置
        await updateThreadAutoCleanupSetting(thread.id, {
            manualThreshold: threshold,
            enableAutoCleanup: enableAutoCleanup
        });

        await interaction.editReply({
            embeds: [
                {
                    color: 0x808080,
                    title: '❌ 无需清理',
                    description: [
                        `当前子区人数(${memberCount})未达到清理阈值(${threshold})`,
                        '',
                        `**🤖 自动清理设置已更新：${enableAutoCleanup ? '启用' : '禁用'}**`,
                        enableAutoCleanup
                            ? '• 系统将在子区达到990人时自动清理至设定的阈值'
                            : '• 系统将不会对此子区进行自动清理',
                    ].join('\n'),
                },
            ],
            flags: ['Ephemeral'],
        });
        return;
    }

    try {
        // 生成任务ID
        const taskId = `admin_cleanup_${thread.id}_${Date.now()}`;

        // 添加任务到后台队列
        await globalRequestQueue.addBackgroundTask({
            task: async () => {
                // 执行清理任务
                const result = await cleanThreadMembers(
                    thread,
                    threshold,
                    {
                        sendThreadReport: true,
                        reportType: 'admin',
                        executor: interaction.user,
                        taskId,
                        whitelistedThreads: guildConfig.automation.whitelistedThreads,
                        manualThreshold: threshold, // 保存管理员手动设置的阈值
                        enableAutoCleanup: enableAutoCleanup // 保存自动清理启用状态
                    }
                );

                // 发送管理日志
                if (result.status === 'completed') {
                    await sendLogReport(
                        interaction.client,
                        guildConfig.threadLogThreadId,
                        result,
                        {
                            type: 'admin',
                            executor: interaction.user
                        }
                    );
                }

                return result;
            },
            taskId,
            taskName: '管理员清理不活跃用户',
            notifyTarget: {
                channel: interaction.channel,
                user: interaction.user
            },
            priority: 2, // 较高优先级
            threadId: thread.id,
            guildId: interaction.guildId
        });

        // 通知用户任务已添加到队列
        await interaction.editReply({
            embeds: [{
                color: 0x00ff00,
                title: '✅ 清理任务已提交成功',
                description: [
                    '清理任务已添加到后台队列，系统已发送专门的通知消息来跟踪任务进度。',
                    '你可以在该通知消息中查看实时状态更新。',
                ].join('\n'),
                timestamp: new Date()
            }],
            flags: ['Ephemeral'],
        });

        logTime(`[管理员清理] ${interaction.user.tag} 提交了清理子区 ${thread.name} 的后台任务 ${taskId}`);
    } catch (error) {
        await interaction.editReply({
            content: `❌ 添加清理任务失败: ${error.message}`,
            flags: ['Ephemeral'],
        });
        throw error;
    }
}
