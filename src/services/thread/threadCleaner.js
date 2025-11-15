import { promises as fs } from 'fs';
import path from 'path';
import { EmbedFactory } from '../../factories/embedFactory.js';
import { delay, globalBatchProcessor, globalRequestQueue } from '../../utils/concurrency.js';
import { logTime } from '../../utils/logger.js';
import { pgSyncScheduler } from '../../schedulers/pgSyncScheduler.js';

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
        // logTime(`[${threadId}] 子区缓存已保存`);
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
 * 更新子区的自动清理设置（不执行清理）
 * @param {string} threadId - 子区ID
 * @param {Object} options - 配置选项
 * @returns {Promise<boolean>} 是否成功更新
 */
export async function updateThreadAutoCleanupSetting(threadId, options = {}) {
    try {
        // 读取现有缓存
        const cache = await loadThreadCache(threadId);

        // 更新缓存
        await saveThreadCache(threadId, {
            lastUpdateTime: cache?.lastUpdateTime || Date.now(),
            lastMessageIds: cache?.lastMessageIds || [],
            activeUsers: cache?.activeUsers || {},
            memberCount: cache?.memberCount || 0,
            lastManualThreshold: options.manualThreshold || cache?.lastManualThreshold || null,
            autoCleanupEnabled: options.enableAutoCleanup ?? cache?.autoCleanupEnabled ?? true
        });

        logTime(`[${threadId}] 已更新自动清理设置: ${options.enableAutoCleanup ? '启用' : '禁用'}`);
        return true;
    } catch (error) {
        logTime(`更新子区自动清理设置失败: ${error.message}`, true);
        return false;
    }
}

/**
 * 获取所有已缓存的子区ID列表
 * @returns {Promise<string[]>} 子区ID数组
 */
export async function getAllCachedThreadIds() {
    try {
        await ensureCacheDirectory();
        const files = await fs.readdir(CACHE_DIR);
        return files
            .filter(file => file.endsWith('.json'))
            .map(file => file.replace('.json', ''));
    } catch (error) {
        logTime(`获取缓存子区列表失败: ${error.message}`, true);
        return [];
    }
}

/**
 * 发送子区清理报告
 * @param {ThreadChannel} thread - 子区对象
 * @param {Object} result - 清理结果
 * @param {Object} options - 配置选项
 * @param {string} options.type - 清理类型: 'auto' | 'manual' | 'admin'
 * @param {Object} options.executor - 执行者信息（手动/管理员清理时）
 */
export const sendThreadReport = async (thread, result, options = {}) => {
    try {
        const { type = 'manual', executor } = options;

        // 读取缓存以获取自动清理状态
        const cache = await loadThreadCache(thread.id);
        const autoCleanupEnabled = cache?.autoCleanupEnabled ?? true;

        const embed = EmbedFactory.createThreadCleanupReportEmbed(result, {
            type,
            autoCleanupEnabled
        });

        await thread.send({
            embeds: [embed],
        });
    } catch (error) {
        logTime(`发送子区报告失败 ${thread.name}: ${error.message}`, true);
    }
};

/**
 * 发送管理日志报告
 * @param {Object} client - Discord客户端
 * @param {string} logChannelId - 日志频道ID
 * @param {Object} result - 清理结果
 * @param {Object} options - 配置选项
 * @param {string} options.type - 清理类型: 'auto' | 'manual' | 'admin'
 * @param {Object} options.executor - 执行者信息（手动/管理员清理时）
 */
export const sendLogReport = async (client, logChannelId, result, options = {}) => {
    try {
        const { type = 'manual', executor } = options;

        const embed = EmbedFactory.createLogCleanupReportEmbed(result, {
            type,
            executor
        });

        const logChannel = await client.channels.fetch(logChannelId);

        await logChannel.send({
            embeds: [embed],
        });
    } catch (error) {
        logTime(`发送管理日志失败: ${error.message}`, true);
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
 * 获取子区的第一条消息（帖子作者）
 * @param {ThreadChannel} thread - Discord子区对象
 * @returns {Promise<string|null>} 帖子作者的用户ID
 */
async function getThreadAuthor(thread) {
    try {
        // 获取第一条消息（帖子的原始消息）
        const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
        const threadStarter = firstMessage.first();
        return threadStarter?.author?.id || null;
    } catch (error) {
        logTime(`获取子区 ${thread.name} 作者失败: ${error.message}`, true);
        return null;
    }
}

/**
 * 检查用户数据是否为新格式
 * @param {any} userData - 用户数据
 * @returns {boolean} 是否为新格式
 */
function isNewUserDataFormat(userData) {
    return typeof userData === 'object' && userData !== null &&
           typeof userData.count === 'number' &&
           typeof userData.lastMessageTime === 'number';
}

/**
 * 清理子区成员
 * @param {ThreadChannel} thread - Discord子区对象
 * @param {number} threshold - 目标人数阈值
 * @param {Object} options - 配置选项
 * @param {boolean} options.sendThreadReport - 是否发送子区报告
 * @param {string} options.reportType - 报告类型: 'auto' | 'manual' | 'admin'
 * @param {Object} options.executor - 执行者信息（手动/管理员清理时）
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

        // 共享成员数据给 PG 同步服务
        if (pgSyncScheduler.isEnabled()) {
            await pgSyncScheduler.receiveMemberData(thread.id, members, thread.client);
        }

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

        // 获取需要保护的用户ID
        const threadAuthorId = await getThreadAuthor(thread);
        const botId = thread.client.user.id;
        const protectedUserIds = new Set([threadAuthorId, botId].filter(Boolean));

        // 获取历史缓存
        const cache = await loadThreadCache(thread.id);
        let cachedMessageIds = [];
        const activeUsers = new Map();

        // 如果存在缓存，读取活跃用户数据
        if (cache) {
            cachedMessageIds = cache.lastMessageIds || [];

            // 恢复活跃用户数据
            if (cache.activeUsers) {
                Object.entries(cache.activeUsers).forEach(([userId, userData]) => {
                    if (isNewUserDataFormat(userData)) {
                        // 新格式：{count, lastMessageTime, lastMessageId}
                        activeUsers.set(userId, userData);
                    } else {
                        // 旧格式：直接是数字（发言条数）
                        activeUsers.set(userId, {
                            count: userData,
                            lastMessageTime: null, // 标记为需要更新
                            lastMessageId: null
                        });
                    }
                });
            }
        }

        // 获取所有消息以统计发言用户
        let lastId = null;
        let messagesProcessed = 0;
        let hasMoreMessages = true;
        let reachedCachedMessages = false;
        const lastMessageIds = [];
        const estimatedTotalMessages = thread.messageCount || 1000; // 估计总消息数，用于计算进度

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
                        // logTime(`[${thread.name}] 检测到缓存的消息，停止扫描`);
                        reachedCachedMessages = true;
                        continue;
                    }
                }

                // 处理消息（更新用户数据到新格式）
                messages.forEach(msg => {
                    const userId = msg.author.id;
                    const messageTime = msg.createdTimestamp;
                    const currentData = activeUsers.get(userId);

                    if (currentData) {
                        // 如果是新格式，直接更新
                        if (isNewUserDataFormat(currentData)) {
                            activeUsers.set(userId, {
                                count: currentData.count + 1,
                                lastMessageTime: Math.max(currentData.lastMessageTime, messageTime),
                                lastMessageId: currentData.lastMessageTime < messageTime ? msg.id : currentData.lastMessageId
                            });
                        } else {
                            // 如果是旧格式或标记为需要更新的，转换为新格式
                            activeUsers.set(userId, {
                                count: (currentData.count || currentData) + 1,
                                lastMessageTime: messageTime,
                                lastMessageId: msg.id
                            });
                        }
                    } else {
                        // 新用户，直接使用新格式
                        activeUsers.set(userId, {
                            count: 1,
                            lastMessageTime: messageTime,
                            lastMessageId: msg.id
                        });
                    }
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

        // 找出未发言的成员（排除保护用户）
        const inactiveMembers = members.filter(member =>
            !activeUsers.has(member.id) && !protectedUserIds.has(member.id)
        );
        const needToRemove = memberCount - threshold;
        let toRemove;

        // 获取所有非保护成员的活跃数据，分为旧格式和新格式
        const allEligibleMembers = Array.from(members.values())
            .filter(member => !protectedUserIds.has(member.id))
            .map(member => {
                const userData = activeUsers.get(member.id);
                const isInactive = !userData;
                const isOldFormat = userData && !isNewUserDataFormat(userData);

                if (isInactive) {
                    return {
                        member,
                        isInactive: true,
                        isOldFormat: false,
                        messageCount: 0,
                        lastMessageTime: 0,
                        priority: 1 // 最高优先级：未发言用户
                    };
                } else if (isOldFormat) {
                    return {
                        member,
                        isInactive: false,
                        isOldFormat: true,
                        messageCount: userData.count || userData,
                        lastMessageTime: 0, // 旧格式没有时间信息
                        priority: 2 // 次高优先级：旧格式用户（优先迁移）
                    };
                } else {
                    return {
                        member,
                        isInactive: false,
                        isOldFormat: false,
                        messageCount: userData.count,
                        lastMessageTime: userData.lastMessageTime,
                        priority: 3 // 最低优先级：新格式用户（按时间排序）
                    };
                }
            });

        // 智能排序：优先移除未发言用户，然后是旧格式用户，最后按时间排序新格式用户
        allEligibleMembers.sort((a, b) => {
            // 首先按优先级排序
            if (a.priority !== b.priority) {
                return a.priority - b.priority;
            }

            // 相同优先级内的排序
            if (a.priority === 1) {
                // 未发言用户：无特殊排序
                return 0;
            } else if (a.priority === 2) {
                // 旧格式用户：按发言条数升序
                return a.messageCount - b.messageCount;
            } else {
                // 新格式用户：按最后发言时间升序（最久未发言的优先）
                return a.lastMessageTime - b.lastMessageTime;
            }
        });

        toRemove = allEligibleMembers.slice(0, needToRemove).map(item => item.member);

        const inactiveCount = toRemove.filter(member => !activeUsers.has(member.id)).length;
        const oldFormatCount = toRemove.filter(member => {
            const userData = activeUsers.get(member.id);
            return userData && !isNewUserDataFormat(userData);
        }).length;
        const newFormatCount = needToRemove - inactiveCount - oldFormatCount;

        logTime(`[${thread.name}] 清理策略 - 未发言用户: ${inactiveCount}, 旧格式用户: ${oldFormatCount}, 新格式用户: ${newFormatCount}`);

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
        activeUsers.forEach((userData, userId) => {
            if (!removedMemberIds.includes(userId)) {
                if (isNewUserDataFormat(userData)) {
                    // 新格式：直接保存
                    activeUsersObj[userId] = userData;
                } else if (userData.lastMessageTime === null) {
                    // 旧格式用户且没有在本次扫描中更新：保持原始旧格式
                    activeUsersObj[userId] = userData.count;
                } else {
                    // 已经更新过的用户：保存新格式
                    activeUsersObj[userId] = userData;
                }
            }
        });

        await saveThreadCache(thread.id, {
            lastUpdateTime: Date.now(),
            lastMessageIds,
            activeUsers: activeUsersObj,
            memberCount: memberCount - result.removedCount,
            lastManualThreshold: options.manualThreshold || cache?.lastManualThreshold || null,
            autoCleanupEnabled: options.enableAutoCleanup ?? cache?.autoCleanupEnabled ?? true // 默认启用
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
            await sendThreadReport(thread, result, {
                type: options.reportType || 'manual',
                executor: options.executor
            });
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
 * 对达到990人的已缓存子区进行顺序清理
 * @param {Object} client - Discord客户端
 * @param {string} guildId - 服务器ID
 * @param {Map} activeThreadsMap - 活跃子区映射表 (threadId -> thread对象)
 * @returns {Promise<Object>} 清理结果统计
 */
export async function cleanupCachedThreadsSequentially(client, guildId, activeThreadsMap) {
    const cleanupResults = {
        totalChecked: 0,
        qualifiedThreads: 0,
        cleanedThreads: 0,
        errors: [],
        details: []
    };

    try {
        // 获取所有缓存的子区ID
        const cachedThreadIds = await getAllCachedThreadIds();

        // 筛选出在活跃列表中且有缓存的子区
        const activeCachedThreads = [];
        for (const threadId of cachedThreadIds) {
            if (activeThreadsMap.has(threadId)) {
                const thread = activeThreadsMap.get(threadId);
                activeCachedThreads.push({ threadId, thread });
            }
        }

        // logTime(`[缓存清理] 在活跃子区中找到 ${activeCachedThreads.length} 个已缓存的子区`);
        cleanupResults.totalChecked = activeCachedThreads.length;

        // 顺序检查每个子区的成员数量并执行清理
        for (const { threadId, thread } of activeCachedThreads) {
            try {
                // 获取子区成员数量
                const members = await thread.members.fetch();
                const memberCount = members.size;

                // 将成员数据共享给 postMembersSyncService
                const { pgSyncScheduler } = await import('../../schedulers/pgSyncScheduler.js');
                if (pgSyncScheduler.isEnabled()) {
                    await pgSyncScheduler.receiveMemberData(threadId, members, client);
                }

                // logTime(`[缓存清理] 子区 ${thread.name} 当前成员数: ${memberCount}`);

                // 检查是否达到990人阈值
                if (memberCount >= 990) {
                    cleanupResults.qualifiedThreads++;

                    // 读取缓存以获取上次手动设置的阈值和自动清理设置
                    const cache = await loadThreadCache(threadId);
                    const inheritedThreshold = cache?.lastManualThreshold || 950; // 默认950
                    const autoCleanupEnabled = cache?.autoCleanupEnabled ?? true; // 默认启用

                    // 检查是否启用了自动清理
                    if (!autoCleanupEnabled) {
                        logTime(`[缓存清理] 子区 ${thread.name} 已禁用自动清理，跳过清理`);
                        cleanupResults.details.push({
                            threadId,
                            threadName: thread.name,
                            originalCount: memberCount,
                            removedCount: 0,
                            status: 'skipped_auto_cleanup_disabled'
                        });
                        continue;
                    }

                    logTime(`[缓存清理] 子区 ${thread.name} 达到990人阈值，使用继承阈值${inheritedThreshold}人进行清理`);

                    // 生成任务ID
                    const taskId = `cached_cleanup_${threadId}_${Date.now()}`;

                    // 执行清理（使用继承的阈值）
                    const cleanupResult = await cleanThreadMembers(thread, inheritedThreshold, {
                        sendThreadReport: true,
                        reportType: 'auto',
                        taskId: taskId
                    });

                    if (cleanupResult.status === 'completed') {
                        cleanupResults.cleanedThreads++;
                        cleanupResults.details.push({
                            threadId,
                            threadName: thread.name,
                            originalCount: cleanupResult.originalCount,
                            removedCount: cleanupResult.removedCount,
                            status: 'success'
                        });
                        logTime(`[缓存清理] 子区 ${thread.name} 清理完成，移除 ${cleanupResult.removedCount} 个成员`);
                    } else {
                        cleanupResults.errors.push({
                            threadId,
                            threadName: thread.name,
                            error: cleanupResult.error || '清理失败',
                            status: cleanupResult.status
                        });
                        logTime(`[缓存清理] 子区 ${thread.name} 清理失败: ${cleanupResult.error || cleanupResult.status}`, true);
                    }
                    await delay(1000);
                }
            } catch (error) {
                cleanupResults.errors.push({
                    threadId,
                    threadName: thread.name,
                    error: error.message
                });
                logTime(`[缓存清理] 处理子区 ${thread.name} 时出错: ${error.message}`, true);
            }
        }

        logTime(`[缓存清理] 完成缓存子区清理任务 - 检查: ${cleanupResults.totalChecked}, 符合条件: ${cleanupResults.qualifiedThreads}, 已清理: ${cleanupResults.cleanedThreads}, 错误: ${cleanupResults.errors.length}`);
        return cleanupResults;

    } catch (error) {
        logTime(`[缓存清理] 缓存子区清理任务执行失败: ${error.message}`, true);
        cleanupResults.errors.push({
            threadId: 'system',
            threadName: '系统',
            error: error.message
        });
        return cleanupResults;
    }
}

