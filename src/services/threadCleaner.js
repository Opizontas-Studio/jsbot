import { globalBatchProcessor } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';

const noop = () => undefined;

/**
 * 发送子区清理报告
 * @param {ThreadChannel} thread - 子区对象
 * @param {Object} result - 清理结果
 */
export const sendThreadReport = async (thread, result) => {
    try {
        await thread.send({
            embeds: [
                {
                    color: 0xffcc00,
                    title: '⚠️ 子区人数已重整',
                    description: [
                        '为保持子区正常运行，系统已移除部分未发言成员。',
                        '被移除的成员可以随时重新加入讨论。',
                    ].join('\n'),
                    fields: [
                        {
                            name: '统计信息',
                            value: [
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
                },
            ],
        });
    } catch (error) {
        logTime(`发送子区报告失败 ${thread.name}: ${error.message}`, true);
    }
};

/**
 * 清理子区成员
 * @param {ThreadChannel} thread - Discord子区对象
 * @param {number} threshold - 目标人数阈值
 * @param {Object} options - 配置选项
 * @param {boolean} options.sendThreadReport - 是否发送子区报告
 * @param {Function} progressCallback - 进度回调函数
 * @returns {Promise<Object>} 清理结果
 */
export const cleanThreadMembers = async (thread, threshold, options = {}, progressCallback = noop) => {
    try {
        // 检查白名单
        if (options.whitelistedThreads?.includes(thread.id)) {
            return {
                status: 'skipped',
                reason: 'whitelisted',
                threadId: thread.id,
                threadName: thread.name,
            };
        }

        // 获取成员列表（这是一个API调用，但已在队列中）
        const members = await thread.members.fetch();
        const memberCount = members.size;

        if (memberCount <= threshold) {
            return {
                status: 'skipped',
                memberCount,
                reason: 'below_threshold',
            };
        }

        // 获取所有消息以统计发言用户
        const activeUsers = new Map();
        let lastId;
        let messagesProcessed = 0;

        // 使用并发控制的批量处理获取消息历史
        async function fetchMessagesBatch(beforeId) {
            const fetchOptions = { limit: 100 };
            if (beforeId) {
                fetchOptions.before = beforeId;
            }

            try {
                const messages = await thread.messages.fetch(fetchOptions);
                return messages;
            } catch (error) {
                logTime(`获取消息批次失败: ${error.message}`, true);
                return null;
            }
        }

        let totalBatches = 0;
        while (true) {
            totalBatches++;

            // 创建批次任务
            const batchTasks = [];
            for (let i = 0; i < 10; i++) {
                if (i === 0) {
                    batchTasks.push(() => fetchMessagesBatch(lastId));
                } else {
                    const prevBatch = await batchTasks[i - 1]();
                    if (!prevBatch || prevBatch.size === 0) {
                        break;
                    }
                    batchTasks.push(() => fetchMessagesBatch(prevBatch.last().id));
                }
            }

            if (batchTasks.length === 0) {
                break;
            }

            // 使用批处理器处理消息批次
            const results = await globalBatchProcessor.processBatch(
                batchTasks,
                task => task(),
                progress => {
                    progressCallback({
                        type: 'message_scan',
                        thread,
                        messagesProcessed,
                        totalBatches,
                        batchProgress: progress,
                    });
                },
                'messageHistory',
            );

            let batchMessagesCount = 0;

            for (const messages of results) {
                if (messages && messages.size > 0) {
                    batchMessagesCount += messages.size;
                    messages.forEach(msg => {
                        const userId = msg.author.id;
                        activeUsers.set(userId, (activeUsers.get(userId) || 0) + 1);
                    });
                    lastId = messages.last().id;
                }
            }

            if (batchMessagesCount === 0) {
                break;
            }
            messagesProcessed += batchMessagesCount;

            await progressCallback({
                type: 'message_scan',
                thread,
                messagesProcessed,
                totalBatches,
            });
        }

        // 找出未发言的成员
        const inactiveMembers = members.filter(member => !activeUsers.has(member.id));
        const needToRemove = memberCount - threshold;
        let toRemove;

        if (inactiveMembers.size >= needToRemove) {
            toRemove = Array.from(inactiveMembers.values()).slice(0, needToRemove);
            logTime(`[${thread.name}] 找到 ${inactiveMembers.size} 个未发言成员，将移除其中 ${needToRemove} 个`);
        } else {
            const remainingToRemove = needToRemove - inactiveMembers.size;
            logTime(`[${thread.name}] 未发言成员不足，将额外移除 ${remainingToRemove} 个低活跃度成员`);

            const memberActivity = Array.from(members.values())
                .map(member => ({
                    member,
                    messageCount: activeUsers.get(member.id) || 0,
                }))
                .sort((a, b) => a.messageCount - b.messageCount);

            toRemove = [
                ...Array.from(inactiveMembers.values()),
                ...memberActivity
                    .filter(item => !inactiveMembers.has(item.member.id))
                    .slice(0, remainingToRemove)
                    .map(item => item.member),
            ];
        }

        const result = {
            status: 'completed',
            name: thread.name,
            url: thread.url,
            originalCount: memberCount,
            removedCount: 0,
            inactiveCount: inactiveMembers.size,
            lowActivityCount: needToRemove - inactiveMembers.size > 0 ? needToRemove - inactiveMembers.size : 0,
            messagesProcessed,
            messagesBatches: totalBatches,
        };

        // 使用 BatchProcessor 处理成员移除
        const removedResults = await globalBatchProcessor.processBatch(
            toRemove,
            async member => {
                try {
                    await thread.members.remove(member.id);
                    return true;
                } catch (error) {
                    logTime(`移除成员失败 ${member.id}: ${error.message}`, true);
                    return false;
                }
            },
            async (progress, processed, total) => {
                result.removedCount = processed;
                await progressCallback({
                    type: 'member_remove',
                    thread,
                    removedCount: processed,
                    totalToRemove: total,
                    batchCount: Math.ceil(processed / 5),
                });
            },
            'memberRemove',
        );

        result.removedCount = removedResults.filter(success => success).length;

        if (options.sendThreadReport) {
            await sendThreadReport(thread, result);
        }

        return result;
    } catch (error) {
        logTime(`清理子区 ${thread.name} 时出错: ${error.message}`, true);
        return {
            status: 'error',
            name: thread.name,
            error: error.message,
        };
    }
};

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

    const result = await cleanThreadMembers(thread, threshold, { sendThreadReport: true }, async progress => {
        if (progress.type === 'message_scan') {
            await interaction.editReply({
                content: `⏳ 正在统计消息历史... (已处理 ${progress.messagesProcessed} 条消息)`,
                flags: ['Ephemeral'],
            });
        } else if (progress.type === 'member_remove') {
            await interaction.editReply({
                content: `⏳ 正在移除未发言成员... (${progress.removedCount}/${progress.totalToRemove})`,
                flags: ['Ephemeral'],
            });
        }
    });

    await handleCleanupResult(interaction, result, threshold);
}

/**
 * 处理清理结果
 * @private
 */
async function handleCleanupResult(interaction, result, threshold) {
    if (result.status === 'skipped') {
        const message =
            result.reason === 'whitelisted'
                ? '✅ 此子区在白名单中，已跳过清理。'
                : `✅ 当前子区人数(${result.memberCount})已经在限制范围内，无需清理。`;

        await interaction.editReply({
            content: message,
            flags: ['Ephemeral'],
        });
        return;
    }

    if (result.status === 'error') {
        throw new Error(result.error);
    }

    // 发送操作日志
    const moderationChannel = await interaction.client.channels.fetch(interaction.guildConfig.moderationLogThreadId);
    await moderationChannel.send({
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

    // 回复执行结果
    await interaction.editReply({
        content: [
            '✅ 子区清理完成！',
            `🎯 目标阈值: ${threshold}`,
            `📊 原始人数: ${result.originalCount}`,
            `👥 活跃用户: ${result.originalCount - result.inactiveCount}`,
            `🚫 已移除: ${result.removedCount}`,
            `👤 当前人数: ${result.originalCount - result.removedCount}`,
        ].join('\n'),
        flags: ['Ephemeral'],
    });
}
