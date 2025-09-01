import { promises as fs } from 'fs';
import path from 'path';
import { delay, globalBatchProcessor, globalRequestQueue } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';

const noop = () => undefined;

// 缓存目录路径
const CACHE_DIR = path.join(process.cwd(), 'data', 'thread_cache');

/**
 * 确保缓存目录存在
 */
async function ensureCacheDirectory() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        logTime(`创建缓存目录失败: ${error.message}`, true);
    }
}

/**
 * 获取子区缓存文件路径
 * @param {string} threadId - 子区ID
 */
function getThreadCacheFilePath(threadId) {
    return path.join(CACHE_DIR, `${threadId}.json`);
}

/**
 * 保存子区缓存信息
 * @param {string} threadId - 子区ID
 * @param {Object} data - 缓存数据
 */
async function saveThreadCache(threadId, data) {
    try {
        await ensureCacheDirectory();
        const filePath = getThreadCacheFilePath(threadId);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        logTime(`[${threadId}] 子区缓存已保存`);
    } catch (error) {
        logTime(`保存子区缓存失败: ${error.message}`, true);
    }
}

/**
 * 读取子区缓存信息
 * @param {string} threadId - 子区ID
 */
async function loadThreadCache(threadId) {
    try {
        const filePath = getThreadCacheFilePath(threadId);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // 如果文件不存在或其他错误，返回null
        return null;
    }
}

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
 * 获取单个批次的消息
 * @private
 */
async function fetchMessagesBatch(thread, lastId = null) {
    const fetchOptions = { limit: 100 }; // 100条消息一批
    if (lastId) {
        fetchOptions.before = lastId;
    }

    try {
        const messages = await thread.messages.fetch(fetchOptions);
        return messages;
    } catch (error) {
        logTime(`获取消息批次失败: ${error.message}`, true);
        throw error;
    }
}

/**
 * 清理子区成员
 * @param {ThreadChannel} thread - Discord子区对象
 * @param {number} threshold - 目标人数阈值
 * @param {Object} options - 配置选项
 * @param {boolean} options.sendThreadReport - 是否发送子区报告
 * @param {string} options.taskId - 任务ID（用于进度更新）
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
            // 更新任务进度显示跳过原因
            if (options.taskId) {
                await globalRequestQueue.updateTaskProgress(
                    options.taskId,
                    `✅ 当前人数(${memberCount})低于阈值(${threshold})，无需清理`,
                    100
                );

                // 等待一段时间让用户看到最终状态
                await delay(3000);
            }

            return {
                status: 'skipped',
                memberCount,
                threshold,
                reason: 'below_threshold',
            };
        }

        // 获取历史缓存
        const cache = await loadThreadCache(thread.id);
        let cachedMessageIds = [];
        let activeUsers = new Map();

        // 如果存在缓存，读取活跃用户数据
        if (cache) {
            logTime(`[${thread.name}] 使用缓存数据`);
            cachedMessageIds = cache.lastMessageIds || [];

            // 恢复活跃用户数据
            if (cache.activeUsers) {
                Object.entries(cache.activeUsers).forEach(([userId, count]) => {
                    activeUsers.set(userId, count);
                });
            }
        }

        // 获取所有消息以统计发言用户
        logTime(`[${thread.name}] 开始子区重整`);
        let lastId = null;
        let messagesProcessed = 0;
        let hasMoreMessages = true;
        let reachedCachedMessages = false;
        let lastMessageIds = [];
        let estimatedTotalMessages = thread.messageCount || 1000; // 估计总消息数，用于计算进度

        // 更新进度：开始扫描消息
        if (options.taskId) {
            await globalRequestQueue.updateTaskProgress(
                options.taskId,
                '正在扫描消息历史...',
                0
            );
        }

        while (hasMoreMessages && !reachedCachedMessages) {
            try {
                // 获取消息批次
                const messages = await fetchMessagesBatch(thread, lastId);

                if (messages.size === 0) {
                    hasMoreMessages = false;
                    continue;
                }

                // 收集最新的消息ID（仅收集前5条，用于下次缓存）
                if (lastMessageIds.length < 5) {
                    messages.forEach(msg => {
                        if (lastMessageIds.length < 5) {
                            lastMessageIds.push(msg.id);
                        }
                    });
                }

                // 检查是否已到达缓存的消息
                if (cachedMessageIds.length > 0) {
                    let foundCached = false;
                    messages.forEach(msg => {
                        if (cachedMessageIds.includes(msg.id)) {
                            foundCached = true;
                        }
                    });

                    if (foundCached) {
                        logTime(`[${thread.name}] 检测到缓存的消息，停止扫描`);
                        reachedCachedMessages = true;
                        continue;
                    }
                }

                // 处理消息
                messages.forEach(msg => {
                    const userId = msg.author.id;
                    activeUsers.set(userId, (activeUsers.get(userId) || 0) + 1);
                });

                // 更新进度
                messagesProcessed += messages.size;
                lastId = messages.last().id;

                // 更新进度显示
                const scanProgress = Math.min(95, (messagesProcessed / estimatedTotalMessages) * 100);
                if (options.taskId) {
                    await globalRequestQueue.updateTaskProgress(
                        options.taskId,
                        `已扫描 ${messagesProcessed} 条消息`,
                        scanProgress
                    );
                }

                await progressCallback({
                    type: 'message_scan',
                    thread,
                    messagesProcessed,
                });

                // 添加延迟避免API限制
                await delay(800);
            } catch (error) {
                logTime(`获取消息批次失败: ${error.message}`, true);
                throw error;
            }
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
        };

        // 使用 BatchProcessor 处理成员移除
        if (options.taskId) {
            await globalRequestQueue.updateTaskProgress(
                options.taskId,
                '开始移除成员...',
                95
            );
        }

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

                // 更新任务进度
                if (options.taskId) {
                    const removeProgress = 95 + (processed / total) * 5; // 95-100%
                    await globalRequestQueue.updateTaskProgress(
                        options.taskId,
                        `正在移除成员 ${processed}/${total}`,
                        removeProgress
                    );
                }

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

        // 保存缓存数据
        // 把Map转换为对象以便存储
        const activeUsersObj = {};
        // 过滤掉已移除的成员
        const removedMemberIds = toRemove.map(member => member.id);
        activeUsers.forEach((count, userId) => {
            if (!removedMemberIds.includes(userId)) {
                activeUsersObj[userId] = count;
            }
        });

        await saveThreadCache(thread.id, {
            lastUpdateTime: Date.now(),
            lastMessageIds,
            activeUsers: activeUsersObj,
            memberCount: memberCount - result.removedCount
        });

        // 最终进度更新
        if (options.taskId) {
            await globalRequestQueue.updateTaskProgress(
                options.taskId,
                `✅ 清理完成！已移除 ${result.removedCount} 个成员`,
                100
            );
        }

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

    await handleCleanupResult(interaction, result, threshold, guildConfig);
}

/**
 * 处理清理结果
 * @private
 * @param {Interaction} interaction - Discord交互对象
 * @param {Object} result - 清理结果
 * @param {number} threshold - 清理阈值
 * @param {Object} guildConfig - 服务器配置
 */
async function handleCleanupResult(interaction, result, threshold, guildConfig) {
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
