import { ChannelType } from 'discord.js';
import { EmbedFactory } from '../../factories/embedFactory.js';
import { delay, globalRequestQueue } from '../../utils/concurrency.js';
import { handleConfirmationButton } from '../../utils/confirmationHelper.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { lockAndArchiveThread } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';
import { cleanThreadMembers, sendLogReport, updateThreadAutoCleanupSetting } from './threadCleaner.js';

/**
 * 自助管理服务层
 * 提供论坛帖子的自助管理功能
 */

/**
 * 验证是否在论坛帖子中
 * @param {Object} channel - Discord频道对象
 * @returns {{isValid: boolean, error: string|null}}
 */
export function validateForumThread(channel) {
    if (!channel.isThread() || channel.parent?.type !== ChannelType.GuildForum) {
        return {
            isValid: false,
            error: '❌ 此命令只能在论坛帖子中使用'
        };
    }
    return { isValid: true, error: null };
}

/**
 * 验证是否为帖子作者
 * @param {Object} thread - Discord帖子对象
 * @param {string} userId - 用户ID
 * @returns {{isValid: boolean, error: string|null}}
 */
export function validateThreadOwner(thread, userId) {
    if (thread.ownerId !== userId) {
        return {
            isValid: false,
            error: '❌ 只有帖子作者才能管理此帖子'
        };
    }
    return { isValid: true, error: null };
}

/**
 * 验证消息所有权
 * @param {Object} message - Discord消息对象
 * @param {string} userId - 用户ID
 * @returns {{isValid: boolean, error: string|null}}
 */
export function validateMessageOwner(message, userId) {
    if (message.author.id !== userId) {
        return {
            isValid: false,
            error: '❌ 你只能操作自己的消息'
        };
    }
    return { isValid: true, error: null };
}

/**
 * 删除帖子
 * @param {Object} interaction - Discord交互对象
 * @param {Object} thread - 帖子对象
 */
export async function handleDeleteThread(interaction, thread) {
    await handleConfirmationButton({
        interaction,
        customId: 'confirm_delete',
        buttonLabel: '确认删贴',
        embed: EmbedFactory.createDeleteThreadConfirmEmbed(thread),
        operationName: '删除帖子',
        onConfirm: async confirmation => {
            await confirmation.update({
                content: '⏳ 正在删除帖子...',
                components: [],
                embeds: [],
            });

            const threadName = thread.name;
            const userTag = interaction.user.tag;

            await ErrorHandler.handleService(
                async () => {
                    await thread.delete('作者自行删除');
                    logTime(`[自助管理] 楼主 ${userTag} 删除了自己的帖子 ${threadName} (id:${thread.id})`);
                },
                '删除帖子',
                { throwOnError: true }
            );
        },
        onError: async (error, interaction) => {
            // 只有当 thread 没有被删除时才显示错误消息
            if (thread.deleted) return;

            await ErrorHandler.handleSilent(
                async () => {
                    await interaction.editReply({
                        content: `❌ 操作失败: ${error.message}`,
                        components: [],
                        embeds: [],
                    });
                },
                '处理删除帖子错误',
            );
        },
    });
}

/**
 * 锁定并关闭帖子
 * @param {Object} interaction - Discord交互对象
 * @param {Object} thread - 帖子对象
 * @param {string} reason - 锁定原因
 */
export async function handleLockThread(interaction, thread, reason) {
    await handleConfirmationButton({
        interaction,
        customId: 'confirm_lock',
        buttonLabel: '确认锁定',
        embed: EmbedFactory.createLockThreadConfirmEmbed(thread, reason),
        operationName: '锁定帖子',
        onConfirm: async confirmation => {
            try {
                await confirmation.deferUpdate();
            } catch (error) {
                logTime(`[锁定帖子确认] deferUpdate失败: ${error.message}`, true);
                return;
            }
            await interaction.editReply({
                content: '⏳ 正在锁定帖子...',
                components: [],
                embeds: [],
            });

            await ErrorHandler.handleInteraction(
                interaction,
                async () => {
                    await lockAndArchiveThread(thread, interaction.user, reason || '楼主已结束讨论');
                },
                '锁定帖子',
                {
                    ephemeral: false,
                    successMessage: '帖子已锁定并归档'
                }
            );
        },
    });
}

/**
 * 清理不活跃用户
 * @param {Object} interaction - Discord交互对象
 * @param {Object} thread - 帖子对象
 * @param {Object} guildConfig - 服务器配置
 * @param {number} threshold - 清理阈值
 * @param {boolean} enableAutoCleanup - 是否启用自动清理
 */
export async function handleCleanInactiveUsers(interaction, thread, guildConfig, threshold, enableAutoCleanup) {
    // 先获取当前成员数量
    const members = await thread.members.fetch();
    const memberCount = members.size;

    // 检查阈值是否大于990
    if (threshold > 990) {
        await interaction.editReply({
            embeds: [EmbedFactory.createCleanupThresholdWarningEmbed(memberCount, threshold, enableAutoCleanup)],
        });

        // 更新自动清理设置（但不保存大于990的阈值）
        await updateThreadAutoCleanupSetting(thread.id, {
            enableAutoCleanup: enableAutoCleanup
        });
        return;
    }

    // 如果人数低于阈值，检查是否需要更新自动清理设置
    if (memberCount < threshold) {
        await updateThreadAutoCleanupSetting(thread.id, {
            manualThreshold: threshold,
            enableAutoCleanup: enableAutoCleanup
        });

        await interaction.editReply({
            embeds: [EmbedFactory.createNoCleanupNeededEmbed(memberCount, threshold, enableAutoCleanup)],
        });
        return;
    }

    await handleConfirmationButton({
        interaction,
        customId: 'confirm_clean',
        buttonLabel: '确认清理',
        embed: EmbedFactory.createCleanInactiveUsersConfirmEmbed(thread, memberCount, threshold, enableAutoCleanup),
        operationName: '清理不活跃用户',
        onConfirm: async confirmation => {
            try {
                await confirmation.deferUpdate();
            } catch (error) {
                logTime(`[清理不活跃用户确认] deferUpdate失败: ${error.message}`, true);
                return;
            }

            await ErrorHandler.handleService(
                async () => {
                    const taskId = `cleanup_${thread.id}_${Date.now()}`;

                    await globalRequestQueue.addBackgroundTask({
                        task: async () => {
                            const result = await cleanThreadMembers(
                                thread,
                                threshold,
                                {
                                    sendThreadReport: true,
                                    reportType: 'manual',
                                    executor: interaction.user,
                                    taskId,
                                    whitelistedThreads: guildConfig.automation.whitelistedThreads,
                                    manualThreshold: threshold,
                                    enableAutoCleanup: enableAutoCleanup
                                }
                            );

                            if (result.status === 'completed') {
                                await sendLogReport(
                                    interaction.client,
                                    guildConfig.threadLogThreadId,
                                    result,
                                    {
                                        type: 'manual',
                                        executor: interaction.user
                                    }
                                );
                            }

                            return result;
                        },
                        taskId,
                        taskName: '清理不活跃用户',
                        notifyTarget: {
                            channel: interaction.channel,
                            user: interaction.user
                        },
                        priority: 2,
                        threadId: thread.id,
                        guildId: interaction.guildId
                    });

                    await interaction.editReply({
                        embeds: [EmbedFactory.createCleanupTaskSubmittedEmbed(enableAutoCleanup)],
                        components: [],
                    });

                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 提交了清理帖子 ${thread.name} 的后台任务 ${taskId}`);
                },
                '添加清理任务',
                { throwOnError: true }
            );
        },
    });
}

/**
 * 删除某用户全部消息
 * @param {Object} interaction - Discord交互对象
 * @param {Object} thread - 帖子对象
 * @param {Object} guildConfig - 服务器配置
 * @param {Object} targetUser - 目标用户对象
 */
export async function handleDeleteUserMessages(interaction, thread, guildConfig, targetUser) {
    // 检查目标用户是否为帖子创建者
    if (targetUser.id === thread.ownerId) {
        return { success: false, error: '❌ 不能删除你自己的消息' };
    }

    // 检查目标用户是否为机器人
    if (targetUser.bot) {
        return { success: false, error: '❌ 不能删除机器人的消息' };
    }

    // 获取目标用户的身份组
    const targetMember = await interaction.guild.members.fetch(targetUser.id);

    // 检查目标用户是否拥有版主权限
    const moderatorRoles = guildConfig.ModeratorRoleIds || [];
    const hasModerationRole = targetMember.roles.cache.some(role => moderatorRoles.includes(role.id));

    if (hasModerationRole) {
        return { success: false, error: '❌ 不能删除具有管理权限用户的消息' };
    }

    await handleConfirmationButton({
        interaction,
        customId: 'confirm_delete_all_msgs',
        buttonLabel: '确认删除',
        embed: EmbedFactory.createDeleteUserMessagesConfirmEmbed(targetUser, thread.name),
        operationName: '删除用户全部消息',
        onConfirm: async confirmation => {
            try {
                await confirmation.deferUpdate();
            } catch (error) {
                logTime(`[删除用户全部消息确认] deferUpdate失败: ${error.message}`, true);
                return;
            }
            await interaction.editReply({
                content: '⏳ 正在扫描消息...',
                components: [],
                embeds: [],
            });

            await deleteUserMessagesInThread(interaction, thread, targetUser);
        },
    });

    return { success: true };
}

/**
 * 在帖子中删除指定用户的所有消息
 * @private
 */
async function deleteUserMessagesInThread(interaction, thread, targetUser) {
    const MAX_MESSAGES_TO_SCAN = 3000;
    let lastId = null;
    let messagesProcessed = 0;
    let deletedCount = 0;
    let hasMoreMessages = true;
    let limitReached = false;

    const updateProgress = async (status = '处理中') => {
        await interaction.editReply({
            content: `⏳ ${status} ${targetUser.tag} 的消息...已扫描: ${messagesProcessed} 条 (上限 ${MAX_MESSAGES_TO_SCAN}) 已删除: ${deletedCount} 条`,
            components: [],
            embeds: [],
        });
    };

    await ErrorHandler.handleService(
        async () => {
            while (hasMoreMessages) {
                await updateProgress('正在获取');

                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                const messages = await thread.messages.fetch(options);

                if (messages.size === 0) {
                    hasMoreMessages = false;
                    continue;
                }

                messagesProcessed += messages.size;
                lastId = messages.last().id;

                if (messagesProcessed >= MAX_MESSAGES_TO_SCAN) {
                    hasMoreMessages = false;
                    limitReached = true;
                    logTime(`[自助管理] 帖子 ${thread.name} 中删除用户 ${targetUser.tag} 消息时达到 ${MAX_MESSAGES_TO_SCAN} 条扫描上限。已扫描 ${messagesProcessed} 条。`);
                }

                await updateProgress('正在处理');
                await delay(800);

                const targetMessages = messages.filter(msg => msg.author.id === targetUser.id);

                for (const message of targetMessages.values()) {
                    try {
                        await message.delete();
                        deletedCount++;

                        if (deletedCount % 10 === 0) {
                            await updateProgress('正在删除');
                        }

                        await delay(1000);
                    } catch (error) {
                        logTime(`删除用户消息失败 (${message.id}): ${error.message}`, true);
                    }
                }

                if (limitReached && !hasMoreMessages) {
                    await updateProgress('已达到扫描上限，正在完成当前批次删除');
                }
            }

            // 尝试移除用户
            try {
                await thread.members.remove(targetUser.id);

                const finalMessage = limitReached
                    ? `✅ 已扫描 ${messagesProcessed} 条消息（达到上限）。已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区。`
                    : `✅ 已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区`;

                await interaction.editReply({
                    content: finalMessage,
                    components: [],
                    embeds: [],
                });

                logTime(`[自助管理] 楼主 ${interaction.user.tag} 删除了用户 ${targetUser.tag} 在帖子 ${thread.name} 中的 ${deletedCount} 条消息并将其移出子区${limitReached ? ` (扫描达到 ${MAX_MESSAGES_TO_SCAN} 条上限，共扫描 ${messagesProcessed} 条)` : ''}`);
            } catch (error) {
                const finalMessage = limitReached
                    ? `⚠️ 已扫描 ${messagesProcessed} 条消息（达到上限）。已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息，但移出子区失败: ${error.message}`
                    : `⚠️ 已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息，但移出子区失败: ${error.message}`;

                await interaction.editReply({
                    content: finalMessage,
                    components: [],
                    embeds: [],
                });

                logTime(`[自助管理] 楼主 ${interaction.user.tag} 删除了用户 ${targetUser.tag} 在帖子 ${thread.name} 中的 ${deletedCount} 条消息，但移出子区失败: ${error.message}${limitReached ? ` (扫描达到 ${MAX_MESSAGES_TO_SCAN} 条上限，共扫描 ${messagesProcessed} 条)` : ''}`, true);
            }
        },
        '删除用户全部消息',
        { throwOnError: true }
    );
}

/**
 * 编辑慢速模式
 * @param {Object} thread - 帖子对象
 * @param {number} newSlowMode - 新的慢速模式值（秒）
 * @param {Object} user - 执行操作的用户
 * @returns {Promise<{oldSlowMode: number, newSlowMode: number}>}
 */
export async function updateSlowMode(thread, newSlowMode, user) {
    const oldSlowMode = thread.rateLimitPerUser || 0;

    await ErrorHandler.handleService(
        async () => {
            await thread.setRateLimitPerUser(newSlowMode);
            logTime(`[自助管理] 楼主 ${user.tag} 更新了帖子 ${thread.name} 的慢速模式：${oldSlowMode}秒 -> ${newSlowMode}秒`);
        },
        '更新帖子慢速模式',
        { throwOnError: true }
    );

    return { oldSlowMode, newSlowMode };
}

/**
 * 标注或取消标注消息
 * @param {Object} message - 消息对象
 * @param {Object} user - 执行操作的用户
 * @param {Object} thread - 帖子对象
 */
export async function togglePinMessage(message, user, thread) {
    const isPinned = message.pinned;
    const action = isPinned ? '取消标注' : '标注';

    // 使用请求队列控制速率
    await globalRequestQueue.add(async () => {
        await ErrorHandler.handleService(
            async () => {
                if (isPinned) {
                    await message.unpin();
                    logTime(`[自助管理] 楼主 ${user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                } else {
                    await message.pin();
                    logTime(`[自助管理] 楼主 ${user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                }
            },
            `${action}消息`,
            { throwOnError: true }
        );
    }, 3); // 优先级3

    return { action, isPinned: !isPinned };
}

/**
 * 删除消息
 * @param {Object} message - 消息对象
 * @param {Object} user - 执行操作的用户
 * @param {Object} thread - 帖子对象
 */
export async function deleteMessage(message, user, thread) {
    const messageContent = message.content;
    const messageAuthor = message.author;

    await ErrorHandler.handleService(
        async () => {
            await message.delete();
            logTime(`[自助管理] 楼主 ${user.tag} 在帖子 ${thread.name} 中删除了 ${messageAuthor.tag} 发送的消息，内容：${messageContent}`);
        },
        '删除消息',
        { throwOnError: true }
    );

    return { messageAuthor };
}

/**
 * 处理移除反应选择菜单交互
 * @param {Object} interaction - Discord交互对象
 * @param {string} messageId - 消息ID
 * @param {string} userId - 用户ID
 * @param {string} selectedValue - 选中的反应值
 */
export async function handleRemoveReaction(interaction, messageId, userId, selectedValue) {
    // 获取消息对象
    const message = await interaction.channel.messages.fetch(messageId);

    if (!message) {
        await interaction.editReply({
            content: '❌ 找不到该消息',
        });
        return;
    }

    // 如果选择"全部"，移除所有反应
    if (selectedValue === 'all') {
        await message.reactions.removeAll();
        await interaction.editReply({
            content: '✅ 已移除消息的所有反应',
        });
        logTime(`[移除反应] ${interaction.user.tag} 移除了消息 ${messageId} 的所有反应`);
    } else {
        // 移除特定反应
        const reaction = message.reactions.cache.get(selectedValue);
        if (reaction) {
            await reaction.remove();
            await interaction.editReply({
                content: `✅ 已移除反应 ${selectedValue}`,
            });
            logTime(`[移除反应] ${interaction.user.tag} 移除了消息 ${messageId} 的反应 ${selectedValue}`);
        } else {
            await interaction.editReply({
                content: '❌ 该反应已不存在',
            });
        }
    }
}

