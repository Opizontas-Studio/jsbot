import { ChannelFlags } from 'discord.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { EmbedFactory } from '../factories/embedFactory.js';
import { delay, globalBatchProcessor } from '../utils/concurrency.js';
import { handleDiscordError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { startQualifiedThreadsCarousel } from './carouselService.js';

// 超时控制的工具函数
const withTimeout = async (promise, ms = 10000, context = '') => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`操作超时: ${context}`)), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

const MESSAGE_IDS_PATH = join(process.cwd(), 'data', 'messageIds.json');

/**
 * 加载消息ID配置
 * @returns {Object} 消息ID配置对象
 */
async function loadMessageIds() {
    try {
        const data = await fs.readFile(MESSAGE_IDS_PATH, 'utf8');
        const messageIds = JSON.parse(data);
        return messageIds;
    } catch (error) {
        // 如果文件不存在或解析失败，创建新的配置
        logTime(`加载消息ID配置失败，将创建新配置: ${error.message}`, true);
        return {};
    }
}

/**
 * 保存消息ID配置
 * @param {Object} messageIds - 消息ID配置对象
 */
async function saveMessageIds(messageIds) {
    await fs.writeFile(MESSAGE_IDS_PATH, JSON.stringify(messageIds, null, 2));
}

/**
 * 从messageIds配置中获取指定类型的频道ID
 * @param {string} guildId - 服务器ID
 * @param {string} type - 消息类型 (top10, statistics, monitor)
 * @param {Object} messageIds - 消息ID配置对象
 * @returns {string|null} 频道ID
 */
function getChannelIdFromMessageIds(guildId, type, messageIds) {
    const guildData = messageIds[guildId];
    if (!guildData || !guildData[type]) {
        return null;
    }

    // 获取该类型下的第一个频道ID（messageIds结构是 {channelId: messageId}）
    const channelIds = Object.keys(guildData[type]);
    return channelIds.length > 0 ? channelIds[0] : null;
}

/**
 * 获取或创建用于发送报告的消息
 * @param {Object} channel - Discord频道对象
 * @param {string} type - 报告类型
 * @param {string} guildId - 服务器ID
 * @param {Object} messageIds - 消息ID配置对象
 * @returns {Promise<Message>} Discord消息对象
 */
export async function getOrCreateMessage(channel, type, guildId, messageIds) {
    // 确保服务器结构存在
    if (!messageIds[guildId]) {
        messageIds[guildId] = {};
    }
    if (!messageIds[guildId][type]) {
        messageIds[guildId][type] = {};
    }

    const channelId = channel.id;
    const existingMessageId = messageIds[guildId][type][channelId];

    if (existingMessageId) {
        try {
            return await channel.messages.fetch(existingMessageId);
        } catch (error) {
            // 如果消息不存在，从配置中删除
            logTime(`消息ID配置中不存在消息: ${error.message}`, true);
            delete messageIds[guildId][type][channelId];
            await saveMessageIds(messageIds);
        }
    }

    // 创建新消息
    const initialEmbed = {
        color: 0x0099ff,
        title: '正在生成报告...',
        timestamp: new Date(),
    };
    const message = await channel.send({ embeds: [initialEmbed] });

    // 保存新消息ID
    messageIds[guildId][type][channelId] = message.id;
    await saveMessageIds(messageIds);
    return message;
}

/**
 * 发送符合频道主条件的子区列表
 * @param {Object} channel - Discord频道对象
 * @param {string} guildId - 服务器ID
 * @param {Array<Object>} threadInfoArray - 子区信息数组
 * @param {Object} messageIds - 消息ID配置对象
 */
async function sendQualifiedThreadsList(channel, guildId, threadInfoArray, messageIds) {
    // 过滤出关注人数达到950的子区
    const qualifiedThreads = threadInfoArray.filter(thread => thread.memberCount >= 950);

    // 按关注人数降序排序，人数相同则按名字字典序排序
    qualifiedThreads.sort((a, b) => {
        if (a.memberCount !== b.memberCount) {
            return b.memberCount - a.memberCount;
        }
        return a.name.localeCompare(b.name);
    });

    // 如果没有符合条件的子区，显示空状态
    if (qualifiedThreads.length === 0) {
        const embed = EmbedFactory.createEmptyQualifiedThreadsEmbed();
        const message = await getOrCreateMessage(channel, 'top10', guildId, messageIds);
        await message.edit({ embeds: [embed] });
        return;
    }

    // 启动轮播逻辑，将数据传递给调度器
    await startQualifiedThreadsCarousel(channel, guildId, qualifiedThreads, messageIds);
}

/**
 * 发送统计报告
 * @param {Object} channel - Discord频道对象
 * @param {string} guildId - 服务器ID
 * @param {Object} statistics - 统计数据
 * @param {Array<Object>} failedOperations - 失败记录
 * @param {Object} messageIds - 消息ID配置对象
 */
async function sendStatisticsReport(channel, guildId, statistics, failedOperations, messageIds) {
    const embed = EmbedFactory.createStatisticsReportEmbed(statistics, failedOperations);
    const message = await getOrCreateMessage(channel, 'statistics', guildId, messageIds);
    await message.edit({ embeds: [embed] });
}

/**
 * 收集并分析子区数据
 * @private
 */
const analyzeThreadsData = async (client, guildId, activeThreads = null) => {
    if (!activeThreads) {
        const guild = await client.guilds.fetch(guildId).catch(error => {
            throw new Error(`获取服务器失败: ${handleDiscordError(error)}`);
        });

        activeThreads = await guild.channels.fetchActiveThreads().catch(error => {
            throw new Error(`获取活跃主题列表失败: ${handleDiscordError(error)}`);
        });
    }

    const statistics = {
        totalThreads: activeThreads.threads.size,
        archivedThreads: 0,
        skippedPinnedThreads: 0,
        processedWithErrors: 0,
        inactiveThreads: {
            over72h: 0,
            over48h: 0,
            over24h: 0,
        },
        qualifiedThreads: {
            over900Members: 0,
        },
        forumDistribution: {},
    };

    const failedOperations = [];
    const currentTime = Date.now();
    const threadArray = Array.from(activeThreads.threads.values());

    // 第一阶段：获取基本信息和成员数量
    const basicInfoResults = await globalBatchProcessor.processBatch(
        threadArray,
        async thread => {
            try {

                // 获取子区消息
                let lastMessage = null;
                try {
                    const messages = await withTimeout(
                        thread.messages.fetch({ limit: 1 }),
                        6000,
                        `获取子区消息 ${thread.name}`,
                    );
                    lastMessage = messages.first();

                    if (!lastMessage) {
                        const moreMessages = await withTimeout(
                            thread.messages.fetch({ limit: 3 }),
                            6000,
                            `获取更多子区消息 ${thread.name}`,
                        );
                        lastMessage = moreMessages.find(msg => msg !== null);
                    }
                } catch (error) {
                    logTime(`获取子区 ${thread.name} 消息失败: ${handleDiscordError(error)}`, true);
                    // 使用子区创建时间作为备选
                    lastMessage = null;
                }

                const lastActiveTime = lastMessage ? lastMessage.createdTimestamp : thread.createdTimestamp;
                const inactiveHours = (currentTime - lastActiveTime) / (1000 * 60 * 60);

                // 获取子区成员数量
                let memberCount = 0;
                try {
                    const members = await withTimeout(
                        thread.members.fetch(),
                        5000,
                        `获取子区成员 ${thread.name}`,
                    );
                    memberCount = members.size;
                    // 增加延迟以避免API限制
                    await delay(200);
                } catch (error) {
                    logTime(`获取子区 ${thread.name} 成员数量失败: ${handleDiscordError(error)}`, true);
                }

                const threadInfo = {
                    thread,
                    threadId: thread.id,
                    name: thread.name,
                    parentId: thread.parentId,
                    parentName: thread.parent?.name || '未知论坛',
                    lastMessageTime: lastActiveTime,
                    inactiveHours,
                    messageCount: thread.messageCount || 0,
                    memberCount,
                    creatorTag: '未知用户', // 默认值
                    isPinned: thread.flags.has(ChannelFlags.Pinned),
                };

                // 仅对符合条件的子区（≥950关注）获取创作者信息
                if (memberCount >= 950 && thread.ownerId) {
                    try {
                        const creator = await withTimeout(
                            client.users.fetch(thread.ownerId),
                            5000,
                            `获取创作者信息 ${thread.name}`,
                        );
                        threadInfo.creatorTag = creator.displayName || creator.username || '未知用户';
                        await delay(100);
                    } catch (error) {
                        logTime(`获取子区 ${thread.name} 创作者信息失败: ${handleDiscordError(error)}`, true);
                        failedOperations.push({
                            threadId: thread.id,
                            threadName: thread.name,
                            operation: '获取创作者信息',
                            error: handleDiscordError(error),
                        });
                    }
                }

                return threadInfo;
            } catch (error) {
                failedOperations.push({
                    threadId: thread.id,
                    threadName: thread.name,
                    operation: '获取基本信息',
                    error: handleDiscordError(error),
                });
                statistics.processedWithErrors++;
                return null;
            }
        },
        null,
        'members',
    );

    const validThreads = basicInfoResults.filter(result => result !== null);

    // 筛选出符合条件的子区（关注人数≥950）
    const qualifiedThreads = validThreads.filter(thread => thread.memberCount >= 950);

    // 合并统计
    validThreads.forEach(thread => {
        if (thread.inactiveHours >= 72) {
            statistics.inactiveThreads.over72h++;
        }
        if (thread.inactiveHours >= 48) {
            statistics.inactiveThreads.over48h++;
        }
        if (thread.inactiveHours >= 24) {
            statistics.inactiveThreads.over24h++;
        }

        // 统计符合频道主条件的子区
        if (thread.memberCount >= 950) {
            statistics.qualifiedThreads.over900Members++;
        }

        if (!statistics.forumDistribution[thread.parentId]) {
            statistics.forumDistribution[thread.parentId] = {
                name: thread.parentName,
                count: 0,
            };
        }
        statistics.forumDistribution[thread.parentId].count++;
    });

    // 按不活跃时长排序
    const sortedThreads = validThreads.sort((a, b) => b.inactiveHours - a.inactiveHours);

    return { statistics, failedOperations, validThreads: sortedThreads };
};

/**
 * 处理置顶子区的重新标注操作
 * @param {Array<Object>} pinnedThreads - 置顶子区列表
 * @returns {Object} 处理结果统计
 * @private
 */
const processPinnedThreads = async (pinnedThreads) => {
    const statistics = {
        totalPinnedThreads: pinnedThreads.length,
        processedSuccessfully: 0,
        processedWithErrors: 0,
    };
    const failedOperations = [];

    for (const threadInfo of pinnedThreads) {
        try {
            const { thread } = threadInfo;

            // 无条件确保子区开启和标注
            await thread.setArchived(true, '定时重归档');
            await delay(300);
            await thread.setArchived(false, '定时重归档');
            await thread.pin('保持标注');

            statistics.processedSuccessfully++;
        } catch (error) {
            const errorMsg = handleDiscordError(error);
            logTime(`设置置顶子区 ${threadInfo.name} 状态失败: ${errorMsg}`, true);

            failedOperations.push({
                threadId: threadInfo.threadId,
                threadName: threadInfo.name,
                operation: '置顶子区重归档',
                error: errorMsg,
            });
            statistics.processedWithErrors++;
        }
    }

    return { statistics, failedOperations };
};

/**
 * 执行子区清理
 * @private
 */
const cleanupThreads = async (validThreads, threshold) => {
    const statistics = {
        totalThreads: validThreads.length,
        archivedThreads: 0,
        skippedPinnedThreads: 0,
        processedWithErrors: 0,
    };
    const failedOperations = [];

    // 计算需要归档的数量，考虑置顶帖
    const pinnedCount = validThreads.filter(t => t.isPinned).length;
    statistics.skippedPinnedThreads = pinnedCount;

    const targetCount = Math.max(threshold - pinnedCount, 0);
    const nonPinnedThreads = validThreads.filter(t => !t.isPinned);

    if (nonPinnedThreads.length > targetCount) {
        const threadsToArchive = nonPinnedThreads.slice(0, nonPinnedThreads.length - targetCount);

        for (const threadInfo of threadsToArchive) {
            try {
                await threadInfo.thread.setArchived(true, '自动清理不活跃主题');
                statistics.archivedThreads++;
            } catch (error) {
                failedOperations.push({
                    threadId: threadInfo.threadId,
                    threadName: threadInfo.name,
                    operation: '归档主题',
                    error: handleDiscordError(error),
                });
                statistics.processedWithErrors++;
            }
        }
    }

    return { statistics, failedOperations };
};

/**
 * 分析子区活跃度并生成报告
 */
export const analyzeForumActivity = async (client, guildConfig, guildId, activeThreads = null) => {
    const totalTimer = measureTime();
    logTime(`开始分析服务器 ${guildId} 的子区活跃度`);

    try {
        // 加载消息ID配置
        const messageIds = await loadMessageIds();

        // 收集数据
        const { statistics, failedOperations, validThreads } = await analyzeThreadsData(client, guildId, activeThreads);

        // 从messageIds获取top10频道ID，如果没有配置则使用默认的logThreadId
        const top10ChannelId = getChannelIdFromMessageIds(guildId, 'top10', messageIds) || guildConfig.automation.logThreadId;
        const top10Channel = await client.channels.fetch(top10ChannelId);

        // 从messageIds获取statistics频道ID，如果没有配置则使用默认的logThreadId
        const statisticsChannelId = getChannelIdFromMessageIds(guildId, 'statistics', messageIds) || guildConfig.automation.logThreadId;
        const statisticsChannel = await client.channels.fetch(statisticsChannelId);

        // 生成报告
        await sendQualifiedThreadsList(top10Channel, guildId, validThreads, messageIds);
        await sendStatisticsReport(statisticsChannel, guildId, statistics, failedOperations, messageIds);

        const executionTime = totalTimer();
        logTime(`活跃度分析完成 - 处理了 ${statistics.totalThreads} 个子区，用时: ${executionTime}秒`);
        return { statistics, failedOperations, validThreads };
    } catch (error) {
        logTime(`服务器 ${guildId} 活跃度分析失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 清理不活跃子区
 */
export const cleanupInactiveThreads = async (client, guildConfig, guildId, threshold, activeThreads = null) => {
    const totalTimer = measureTime();
    logTime(`[自动清理] 开始清理服务器 ${guildId} 的不活跃子区`);

    try {
        // 加载消息ID配置
        const messageIds = await loadMessageIds();

        // 从messageIds获取statistics频道ID，如果没有配置则使用默认的logThreadId
        const statisticsChannelId = getChannelIdFromMessageIds(guildId, 'statistics', messageIds) || guildConfig.automation.logThreadId;
        const logChannel = await client.channels.fetch(statisticsChannelId);

        // 收集数据
        const { statistics, failedOperations, validThreads } = await analyzeThreadsData(client, guildId, activeThreads);

        // 执行清理
        const cleanupResult = await cleanupThreads(validThreads, threshold);

        // 在清理完成后处理置顶子区
        const pinnedThreads = validThreads.filter(thread => thread.isPinned);
        let pinnedResult = null;
        if (pinnedThreads.length > 0) {
            pinnedResult = await processPinnedThreads(pinnedThreads);
        }

        // 合并统计结果
        Object.assign(statistics, cleanupResult.statistics);
        failedOperations.push(...cleanupResult.failedOperations);

        // 合并置顶子区处理结果
        if (pinnedResult) {
            failedOperations.push(...pinnedResult.failedOperations);
        }

        // 从messageIds获取top10频道ID，如果没有配置则使用默认的logThreadId
        const top10ChannelId = getChannelIdFromMessageIds(guildId, 'top10', messageIds) || guildConfig.automation.logThreadId;
        const top10Channel = await client.channels.fetch(top10ChannelId);

        // 生成报告
        await sendQualifiedThreadsList(top10Channel, guildId, validThreads, messageIds);
        await sendStatisticsReport(logChannel, guildId, statistics, failedOperations, messageIds);

        // 输出清理结果日志
        logTime(`[自动清理] 清理统计: 总活跃子区数 ${statistics.totalThreads}, 已清理子区数 ${cleanupResult.statistics.archivedThreads}, 跳过置顶子区 ${cleanupResult.statistics.skippedPinnedThreads}, 清理阈值 ${threshold}`);

        if (failedOperations.length > 0) {
            logTime(`[自动清理] 清理失败记录: ${failedOperations.length}个操作失败`, true);
            failedOperations.slice(0, 5).forEach(fail => {
                logTime(`  - ${fail.threadName}: ${fail.operation} (${fail.error})`, true);
            });
            if (failedOperations.length > 5) {
                logTime(`  - 以及其他 ${failedOperations.length - 5} 个错误...`, true);
            }
        }

        const executionTime = totalTimer();
        logTime(`[自动清理] 清理操作完成 - 清理了 ${cleanupResult.statistics.archivedThreads} 个子区，用时: ${executionTime}秒`);
        return { statistics, failedOperations };
    } catch (error) {
        logTime(`服务器 ${guildId} 清理操作失败: ${error.message}`, true);
        throw error;
    }
};

/**
 * 根据配置模式执行子区管理操作
 * @param {Object} client - Discord客户端
 * @param {Object} guildConfig - 服务器配置
 * @param {string} guildId - 服务器ID
 * @param {Object} activeThreads - 活跃子区列表（可选）
 */
export const executeThreadManagement = async (client, guildConfig, guildId, activeThreads = null) => {
    // 检查配置的模式
    const mode = guildConfig.automation.mode;
    const threshold = guildConfig.automation.threshold;

    if (mode === 'disabled') {
        logTime(`服务器 ${guildId} 未启用子区自动管理`);
        return null;
    }

    try {
        if (mode === 'analysis') {
            // 仅执行分析，不清理
            return await analyzeForumActivity(client, guildConfig, guildId, activeThreads);
        } else if (mode === 'cleanup') {
            // 分析并执行清理
            return await cleanupInactiveThreads(client, guildConfig, guildId, threshold, activeThreads);
        }
    } catch (error) {
        logTime(`服务器 ${guildId} 子区管理操作失败: ${error.message}`, true);
        throw error;
    }
};
