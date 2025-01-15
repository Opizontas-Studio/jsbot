const { logTime } = require('./common');

/**
 * 发送子区清理报告
 * @param {ThreadChannel} thread - 子区对象
 * @param {Object} result - 清理结果
 */
async function sendThreadReport(thread, result) {
    try {
        await thread.send({
            embeds: [{
                color: 0xffcc00,
                title: '⚠️ 子区人数已重整',
                description: [
                    '为保持子区正常运行，系统已移除部分未发言成员。',
                    '被移除的成员可以随时重新加入讨论。'
                ].join('\n'),
                fields: [
                    {
                        name: '统计信息',
                        value: [
                            `原始人数: ${result.originalCount}`,
                            `移除人数: ${result.removedCount}`,
                            `当前人数: ${result.originalCount - result.removedCount}`,
                            result.lowActivityCount > 0 ? 
                                `(包含 ${result.lowActivityCount} 个低活跃度成员)` : 
                                ''
                        ].filter(Boolean).join('\n'),
                        inline: false
                    }
                ],
                timestamp: new Date()
            }]
        });
    } catch (error) {
        logTime(`发送子区报告失败 ${thread.name}: ${error.message}`, true);
    }
}

/**
 * 清理子区成员
 * @param {ThreadChannel} thread - Discord子区对象
 * @param {number} threshold - 目标人数阈值
 * @param {Object} options - 配置选项
 * @param {boolean} options.sendThreadReport - 是否发送子区报告
 * @param {Function} progressCallback - 进度回调函数
 * @returns {Promise<Object>} 清理结果
 */
async function cleanThreadMembers(thread, threshold, options = {}, progressCallback = () => {}) {
    try {
        // 检查是否在白名单中 - 直接返回，不执行任何成员获取操作
        if (options.whitelistedThreads?.includes(thread.id)) {
            return {
                status: 'skipped',
                reason: 'whitelisted',
                threadId: thread.id,
                threadName: thread.name
            };
        }

        // 获取完整的成员列表
        const members = await thread.members.fetch();
        const memberCount = members.size;

        // 如果人数已经低于阈值，无需处理
        if (memberCount <= threshold) {
            return {
                status: 'skipped',
                memberCount,
                reason: 'below_threshold'
            };
        }

        // 获取所有消息以统计发言用户
        const activeUsers = new Map();
        let lastId;
        let messagesProcessed = 0;

        // 使用并行批处理获取消息历史
        async function fetchMessagesBatch(beforeId) {
            const options = { limit: 100 };
            if (beforeId) options.before = beforeId;
            
            try {
                const messages = await thread.messages.fetch(options);
                return messages;
            } catch (error) {
                logTime(`获取消息批次失败: ${error.message}`, true);
                return null;
            }
        }

        let totalBatches = 0;
        while (true) {
            totalBatches++;
            // 创建10个并行批次
            const batchPromises = [];
            for (let i = 0; i < 10; i++) {
                if (i === 0) {
                    batchPromises.push(fetchMessagesBatch(lastId));
                } else {
                    const prevBatch = await batchPromises[i - 1];
                    if (!prevBatch || prevBatch.size === 0) break;
                    batchPromises.push(fetchMessagesBatch(prevBatch.last().id));
                }
            }

            if (batchPromises.length === 0) break;

            const results = await Promise.all(batchPromises);
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

            if (batchMessagesCount === 0) break;
            messagesProcessed += batchMessagesCount;
            
            await progressCallback({
                type: 'message_scan',
                thread,
                messagesProcessed,
                totalBatches
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

            const memberActivity = Array.from(members.values()).map(member => ({
                member,
                messageCount: activeUsers.get(member.id) || 0
            })).sort((a, b) => a.messageCount - b.messageCount);

            toRemove = [
                ...Array.from(inactiveMembers.values()),
                ...memberActivity
                    .filter(item => !inactiveMembers.has(item.member.id))
                    .slice(0, remainingToRemove)
                    .map(item => item.member)
            ];
        }

        // 使用5个一组的并行批处理来移除成员
        let removedCount = 0;
        let removeBatchCount = 0;

        for (let i = 0; i < toRemove.length; i += 5) {
            removeBatchCount++;
            const batch = toRemove.slice(i, i + 5);
            const removePromises = batch.map(async member => {
                try {
                    await thread.members.remove(member.id);
                    return true;
                } catch (error) {
                    logTime(`移除成员失败 ${member.id}: ${error.message}`, true);
                    return false;
                }
            });

            const results = await Promise.all(removePromises);
            const batchRemoved = results.filter(success => success).length;
            removedCount += batchRemoved;

            await progressCallback({
                type: 'member_remove',
                thread,
                removedCount,
                totalToRemove: toRemove.length,
                batchCount: removeBatchCount
            });
        }

        const result = {
            status: 'completed',
            name: thread.name,
            url: thread.url,
            originalCount: memberCount,
            removedCount,
            inactiveCount: inactiveMembers.size,
            lowActivityCount: needToRemove - inactiveMembers.size > 0 ? needToRemove - inactiveMembers.size : 0,
            messagesProcessed,
            messagesBatches: totalBatches
        };

        // 如果配置了发送子区报告，则发送
        if (options.sendThreadReport) {
            await sendThreadReport(thread, result);
        }

        return result;

    } catch (error) {
        logTime(`清理子区 ${thread.name} 时出错: ${error.message}`, true);
        return {
            status: 'error',
            name: thread.name,
            error: error.message
        };
    }
}

module.exports = {
    cleanThreadMembers,
    sendThreadReport
}; 