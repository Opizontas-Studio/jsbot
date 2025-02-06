import { Collection, SlashCommandBuilder } from 'discord.js';
import { handleConfirmationButton } from '../handlers/buttons.js';
import { generateProgressReport, globalBatchProcessor } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('频道完全清理')
        .setDescription('清理指定范围内的所有消息')
        .addStringOption(option =>
            option
                .setName('终点消息id')
                .setDescription('终点消息的ID（该消息及其之后的消息将被保留）')
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20),
        )
        .addStringOption(option =>
            option
                .setName('起点消息id')
                .setDescription('起点消息的ID（该消息之前的消息将被保留）')
                .setRequired(false)
                .setMinLength(17)
                .setMaxLength(20),
        ),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const executionTimer = measureTime();

        try {
            const endMessageId = interaction.options.getString('终点消息id');
            const startMessageId = interaction.options.getString('起点消息id');

            // 验证消息ID格式
            if (!/^\d{17,20}$/.test(endMessageId)) {
                await interaction.editReply('❌ 无效的终点消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }
            if (startMessageId && !/^\d{17,20}$/.test(startMessageId)) {
                await interaction.editReply('❌ 无效的起点消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }

            // 获取终点消息
            const channel = interaction.channel;
            const endMessage = await channel.messages.fetch(endMessageId).catch(() => null);
            let startMessage = null;

            if (!endMessage) {
                await interaction.editReply('❌ 无法找到指定的终点消息。请确保消息ID正确且在当前频道中');
                return;
            }

            if (startMessageId) {
                startMessage = await channel.messages.fetch(startMessageId).catch(() => null);
                if (!startMessage) {
                    await interaction.editReply('❌ 无法找到指定的起点消息。请确保消息ID正确且在当前频道中');
                    return;
                }
                // 检查起点消息是否在终点消息之后
                if (startMessage.createdTimestamp >= endMessage.createdTimestamp) {
                    await interaction.editReply('❌ 起点消息必须在终点消息之前');
                    return;
                }
            }

            // 获取指定范围内的消息
            let messages;
            try {
                // 直接获取指定范围内的消息（最多100条）
                messages = await channel.messages.fetch({
                    limit: 100,
                    before: endMessage.id,
                    after: startMessageId || '0',
                });

                // 如果消息数量为100条，说明可能还有更多消息
                if (messages.size === 100) {
                    let lastMessage = messages.last();
                    let additionalMessages;

                    // 继续获取剩余消息，直到获取完所有指定范围内的消息
                    while (lastMessage && (!startMessageId || lastMessage.id !== startMessageId)) {
                        additionalMessages = await channel.messages.fetch({
                            limit: 100,
                            before: lastMessage.id,
                            after: startMessageId || '0',
                        });

                        if (additionalMessages.size === 0) {
                            break;
                        }

                        messages = new Collection([...messages, ...additionalMessages]);
                        lastMessage = additionalMessages.last();
                    }
                }
            } catch (error) {
                logTime(`获取消息时出错: ${error.message}`, true);
                await interaction.editReply('❌ 获取消息时出现错误，请稍后重试');
                return;
            }

            const totalMessages = messages.size;
            if (totalMessages === 0) {
                await interaction.editReply('❌ 指定范围内没有可以清理的消息');
                return;
            }

            await handleConfirmationButton({
                interaction,
                customId: 'confirm_purge',
                buttonLabel: '确认清理',
                embed: {
                    color: 0xff0000,
                    title: '⚠️ 清理确认',
                    description: [
                        `你确定要清理 ${channel.name} 中的历史消息吗？`,
                        '',
                        '**清理范围：**',
                        `- 终点消息：${endMessage.content.slice(0, 100)}...`,
                        startMessage ? `- 起点消息：${startMessage.content.slice(0, 100)}...` : '- 起点：频道开始',
                        `- 预计清理消息数：${totalMessages}`,
                        `- 清理时间范围：${
                            startMessage ? startMessage.createdAt.toLocaleString() + ' 至 ' : ''
                        }${endMessage.createdAt.toLocaleString()}`,
                        '',
                        '**⚠️ 警告：此操作不可撤销！**',
                    ].join('\n'),
                },
                onConfirm: async confirmation => {
                    await confirmation.update({
                        content: '正在清理消息...',
                        embeds: [],
                        components: [],
                    });

                    let deletedCount = 0;
                    let processedCount = 0;
                    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

                    // 分离新旧消息
                    const recentMessages = Array.from(messages.values()).filter(
                        msg => msg.createdTimestamp > twoWeeksAgo,
                    );
                    const oldMessages = Array.from(messages.values()).filter(
                        msg => msg.createdTimestamp <= twoWeeksAgo,
                    );

                    // 处理新消息（可以批量删除）
                    if (recentMessages.length > 0) {
                        // 如果消息数量小于等于100，直接一次性删除
                        if (recentMessages.length <= 100) {
                            try {
                                await channel.bulkDelete(recentMessages);
                                deletedCount += recentMessages.length;
                                processedCount += recentMessages.length;

                                await confirmation.editReply({
                                    content: generateProgressReport(processedCount, totalMessages, {
                                        prefix: '清理进度',
                                        suffix: `(批量删除了 ${recentMessages.length} 条新消息)`,
                                        progressChar: '🗑️',
                                    }),
                                });
                            } catch (error) {
                                logTime(`批量删除消息失败: ${error.message}`, true);
                            }
                        } else {
                            // 将消息分成100条一组进行批量删除
                            const recentMessageBatches = [];
                            for (let i = 0; i < recentMessages.length; i += 100) {
                                recentMessageBatches.push(recentMessages.slice(i, i + 100));
                            }

                            await globalBatchProcessor.processBatch(
                                recentMessageBatches,
                                async messageBatch => {
                                    try {
                                        await channel.bulkDelete(messageBatch);
                                        deletedCount += messageBatch.length;
                                        processedCount += messageBatch.length;

                                        await confirmation.editReply({
                                            content: generateProgressReport(processedCount, totalMessages, {
                                                prefix: '清理进度',
                                                suffix: `(批量删除了 ${messageBatch.length} 条新消息)`,
                                                progressChar: '🗑️',
                                            }),
                                        });
                                    } catch (error) {
                                        logTime(`批量删除消息失败: ${error.message}`, true);
                                    }
                                },
                                null,
                                'messages',
                            );
                        }
                    }

                    // 处理旧消息（需要逐个删除）
                    if (oldMessages.length > 0) {
                        // 如果旧消息数量较少，直接逐个删除
                        if (oldMessages.length <= 10) {
                            for (const message of oldMessages) {
                                try {
                                    await message.delete();
                                    deletedCount++;
                                    processedCount++;
                                } catch (error) {
                                    logTime(`删除旧消息失败: ${error.message}`, true);
                                }
                            }
                            // 更新一次进度
                            await confirmation.editReply({
                                content: generateProgressReport(processedCount, totalMessages, {
                                    prefix: '清理进度',
                                    suffix: '(完成旧消息删除)',
                                    progressChar: '🗑️',
                                }),
                            });
                        } else {
                            // 使用批处理器处理大量旧消息
                            await globalBatchProcessor.processBatch(
                                oldMessages,
                                async message => {
                                    try {
                                        await message.delete();
                                        deletedCount++;
                                        processedCount++;

                                        // 每删除5条消息更新一次进度
                                        if (processedCount % 5 === 0) {
                                            await confirmation.editReply({
                                                content: generateProgressReport(processedCount, totalMessages, {
                                                    prefix: '清理进度',
                                                    suffix: '(正在逐个删除旧消息)',
                                                    progressChar: '🗑️',
                                                }),
                                            });
                                        }
                                    } catch (error) {
                                        logTime(`删除旧消息失败: ${error.message}`, true);
                                    }
                                },
                                null,
                                'messages',
                            );
                        }
                    }

                    const executionTime = executionTimer();

                    // 发送完成消息
                    await confirmation.editReply({
                        content: [
                            '✅ 清理完成！',
                            `📊 共清理 ${deletedCount} 条消息`,
                            `⏱️ 执行时间: ${executionTime}秒`,
                        ].join('\n'),
                        embeds: [],
                        components: [],
                    });

                    // 记录到日志频道
                    if (guildConfig.moderationLogThreadId) {
                        const logChannel = await interaction.client.channels.fetch(guildConfig.moderationLogThreadId);
                        await logChannel.send({
                            embeds: [
                                {
                                    color: 0x0099ff,
                                    title: '频道清理日志',
                                    fields: [
                                        {
                                            name: '操作人',
                                            value: `<@${interaction.user.id}>`,
                                            inline: true,
                                        },
                                        {
                                            name: '清理频道',
                                            value: `<#${channel.id}>`,
                                            inline: true,
                                        },
                                        {
                                            name: '清理范围',
                                            value: startMessage
                                                ? `${startMessage.createdAt.toLocaleString()} 至 ${endMessage.createdAt.toLocaleString()}`
                                                : `${endMessage.createdAt.toLocaleString()} 之前的消息`,
                                            inline: false,
                                        },
                                        {
                                            name: '清理数量',
                                            value: `${deletedCount} 条消息`,
                                            inline: true,
                                        },
                                        {
                                            name: '执行时间',
                                            value: `${executionTime}秒`,
                                            inline: true,
                                        },
                                    ],
                                    timestamp: new Date(),
                                },
                            ],
                        });
                    }

                    // 记录到控制台日志
                    logTime(
                        `管理员 ${interaction.user.tag} 清理了频道 ${channel.name} 中的 ${deletedCount} 条消息，耗时 ${executionTime}秒`,
                    );
                },
                onError: async error => {
                    logTime(`清理消息时出错: ${error}`, true);
                    await interaction.editReply({
                        content: '❌ 清理过程中出现错误，请稍后重试。',
                        embeds: [],
                        components: [],
                    });
                },
            });
        } catch (error) {
            await handleCommandError(interaction, error, '频道清理');
        }
    },
};
