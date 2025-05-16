import { Collection, SlashCommandBuilder } from 'discord.js';
import { delay, generateProgressReport, globalBatchProcessor } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 10,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('批量删除消息')
        .setDescription('批量删除指定范围内的消息')
        .addStringOption(option =>
            option
                .setName('起点消息id')
                .setDescription('起点消息的ID（该消息及其之后的消息将被清理）')
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20),
        )
        .addStringOption(option =>
            option
                .setName('终点消息id')
                .setDescription('终点消息的ID（该消息及其之前的消息将被清理）')
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
            const startMessageId = interaction.options.getString('起点消息id');
            const endMessageId = interaction.options.getString('终点消息id');

            // 验证消息ID格式
            if (!/^\d{17,20}$/.test(startMessageId)) {
                await interaction.editReply('❌ 无效的起点消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }
            if (endMessageId && !/^\d{17,20}$/.test(endMessageId)) {
                await interaction.editReply('❌ 无效的终点消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }

            // 获取起点消息
            const channel = interaction.channel;
            const startMessage = await channel.messages.fetch(startMessageId).catch(() => null);
            let endMessage = null;

            if (!startMessage) {
                await interaction.editReply('❌ 无法找到指定的起点消息。请确保消息ID正确且在当前频道中');
                return;
            }

            if (endMessageId) {
                endMessage = await channel.messages.fetch(endMessageId).catch(() => null);
                if (!endMessage) {
                    await interaction.editReply('❌ 无法找到指定的终点消息。请确保消息ID正确且在当前频道中');
                    return;
                }
                // 检查终点消息是否在起点消息之前
                if (endMessage.createdTimestamp <= startMessage.createdTimestamp) {
                    await interaction.editReply('❌ 终点消息必须在起点消息之后');
                    return;
                }
            }

            // 估算消息数量（通过获取一批消息来更准确地估算）
            let estimatedCount = '未知（将清理至频道末尾）';
            try {
                // 从起点消息获取一批消息，先确保将起点消息加入计算
                const options = {
                    limit: 100,
                };

                // 如果有终点ID，则使用before参数获取从起点到终点之间的消息
                if (endMessageId) {
                    options.before = endMessageId;
                }

                // 获取批次消息
                const sampleBatch = await channel.messages.fetch(options);

                // 过滤出起点之后（包括起点）的消息
                const relevantMessages = sampleBatch.filter(
                    msg => BigInt(msg.id) >= BigInt(startMessageId) &&
                          (!endMessageId || BigInt(msg.id) < BigInt(endMessageId))
                );

                if (endMessageId) {
                    // 如果指定了终点消息ID
                    if (relevantMessages.size > 0) {
                        // 返回实际消息数量
                        estimatedCount = String(relevantMessages.size);
                    } else if (sampleBatch.size >= 100) {
                        // 如果没有相关消息但获取了满100条，可能是因为消息间隔过大
                        estimatedCount = '超过100条';
                    } else {
                        // 如果没有消息且未获取满100条
                        estimatedCount = '0';
                    }
                } else {
                    // 如果没有指定终点消息ID
                    if (relevantMessages.size >= 100 || sampleBatch.size >= 100) {
                        estimatedCount = '至少100条';
                    } else {
                        estimatedCount = String(relevantMessages.size);
                    }
                }
            } catch (error) {
                logTime(`估算消息数量失败: ${error.message}`, true);
                // 发生错误时，使用原来的估算方法作为备选
                if (endMessageId) {
                    estimatedCount = String(((BigInt(endMessageId) - BigInt(startMessageId)) / BigInt(1000))) + ' (估计)';
                }
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
                        `- 起点消息：${startMessage.content?.slice(0, 100) || '[无内容]'}...`,
                        endMessage ? `- 终点消息：${endMessage.content?.slice(0, 100) || '[无内容]'}...` : '- 终点：频道结束',
                        `- 预计清理消息数：约${estimatedCount}条`,
                        `- 清理时间范围：${
                            startMessage.createdAt.toLocaleString() + ' 至 ' + (endMessage ? endMessage.createdAt.toLocaleString() : '频道结束')
                        }`,
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
                    let messages = new Collection();
                    let currentId = endMessageId || null;

                    // 获取消息
                    while (true) {
                        const options = {
                            limit: 100,
                            before: currentId || undefined,
                        };

                        const batch = await channel.messages.fetch(options);
                        if (batch.size === 0) break;

                        // 找到起点消息或更早的消息时停止
                        const reachedStart = Array.from(batch.values()).some(msg =>
                            BigInt(msg.id) <= BigInt(startMessageId)
                        );

                        // 过滤出需要删除的消息（在起点之后的消息）
                        const batchToDelete = batch.filter(msg =>
                            BigInt(msg.id) >= BigInt(startMessageId)
                        );

                        if (batchToDelete.size > 0) {
                            messages = new Collection([...messages, ...batchToDelete]);
                        }

                        if (reachedStart || batch.size < 100) break;
                        currentId = batch.last().id;

                        await delay(1000);
                    }

                    const totalMessages = messages.size;
                    if (totalMessages === 0) {
                        await confirmation.editReply('❌ 指定范围内没有可以清理的消息');
                        return;
                    }

                    // 分离新旧消息
                    const recentMessages = Array.from(messages.values()).filter(
                        msg => msg.createdTimestamp > twoWeeksAgo,
                    );
                    const oldMessages = Array.from(messages.values()).filter(
                        msg => msg.createdTimestamp <= twoWeeksAgo,
                    );

                    // 处理新消息（批量删除）
                    if (recentMessages.length > 0) {
                        const recentMessageBatches = [];
                        for (let i = 0; i < recentMessages.length; i += 100) {
                            recentMessageBatches.push(recentMessages.slice(i, i + 100));
                        }

                        for (const batch of recentMessageBatches) {
                            try {
                                await channel.bulkDelete(batch);
                                deletedCount += batch.length;
                                processedCount += batch.length;

                                await confirmation.editReply({
                                    content: generateProgressReport(processedCount, totalMessages, {
                                        prefix: '清理进度',
                                        suffix: `(已删除 ${processedCount}/${totalMessages} 条消息)`,
                                        progressChar: '🗑️',
                                    }),
                                });
                            } catch (error) {
                                logTime(`批量删除消息失败: ${error.message}`, true);
                            }
                            await delay(1000);
                        }
                    }

                    // 处理旧消息（单条删除）
                    if (oldMessages.length > 0) {
                        await globalBatchProcessor.processBatch(
                            oldMessages,
                            async message => {
                                try {
                                    await message.delete();
                                    deletedCount++;
                                    processedCount++;

                                    if (processedCount % 5 === 0) {
                                        await confirmation.editReply({
                                            content: generateProgressReport(processedCount, totalMessages, {
                                                prefix: '清理进度',
                                                suffix: `(已删除 ${processedCount}/${totalMessages} 条消息)`,
                                                progressChar: '🗑️',
                                            }),
                                        });
                                    }
                                } catch (error) {
                                    logTime(`删除旧消息失败: ${error.message}`, true);
                                }
                            },
                            null,
                            'deletion',
                        );
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

                    if(guildConfig.threadLogThreadId){
                        const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
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
                                            value: startMessage.createdAt.toLocaleString() + ' 至 ' + (endMessage ? endMessage.createdAt.toLocaleString() : '频道结束'),
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
