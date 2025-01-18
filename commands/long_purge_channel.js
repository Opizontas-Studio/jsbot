import { SlashCommandBuilder } from 'discord.js';
import { checkAndHandlePermission, measureTime, delay, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { handleConfirmationButton } from '../handlers/buttons.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('频道完全清理')
        .setDescription('清理指定消息之前的所有消息')
        .addStringOption(option =>
            option
                .setName('终点消息id')
                .setDescription('终点消息的ID（该消息及其之后的消息将被保留）')
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20)),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds)) return;

        const executionTimer = measureTime();

        try {
            const messageId = interaction.options.getString('终点消息id');
            
            // 验证消息ID格式
            if (!/^\d{17,20}$/.test(messageId)) {
                await interaction.editReply('❌ 无效的消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }

            // 获取终点消息
            const channel = interaction.channel;
            const endMessage = await channel.messages.fetch(messageId)
                .catch(() => null);

            if (!endMessage) {
                await interaction.editReply('❌ 无法找到指定的消息。请确保消息ID正确且在当前频道中');
                return;
            }

            // 获取消息数量估算
            const messages = await channel.messages.fetch({ 
                limit: 100,
                before: endMessage.id 
            });

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
                        `- 预计清理消息数：${messages.size}+`,
                        `- 清理时间范围：${endMessage.createdAt.toLocaleString()} 之前的消息`,
                        '',
                        '**⚠️ 警告：此操作不可撤销！**'
                    ].join('\n')
                },
                onConfirm: async (confirmation) => {
                    await confirmation.update({
                        content: '正在清理消息...',
                        embeds: [],
                        components: []
                    });

                    let deletedCount = 0;
                    let lastId = endMessage.id;
                    let batchSize = 100;

                    while (true) {
                        // 获取消息批次
                        const messageBatch = await channel.messages.fetch({ 
                            limit: batchSize,
                            before: lastId 
                        });

                        if (messageBatch.size === 0) break;

                        // 记录最后一条消息的ID
                        lastId = messageBatch.last().id;

                        // 过滤出14天内的消息用于批量删除
                        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                        const recentMessages = messageBatch.filter(msg => msg.createdTimestamp > twoWeeksAgo);
                        const oldMessages = messageBatch.filter(msg => msg.createdTimestamp <= twoWeeksAgo);
                        logTime(`开始批量删除 ${recentMessages.size} 条新消息`);
                        logTime(`开始删除 ${oldMessages.size} 条旧消息`);

                        // 批量删除新消息
                        if (recentMessages.size > 0) {
                            await channel.bulkDelete(recentMessages);
                            await delay(200);
                        }

                        // 逐个删除旧消息
                        if (oldMessages.size > 0) {
                            // 每批5条消息
                            const batchSize = 5;
                            for (let i = 0; i < oldMessages.size; i += batchSize) {
                                const batch = Array.from(oldMessages.values()).slice(i, i + batchSize);
                                
                                // 每条等待200ms
                                for (const message of batch) {
                                    await message.delete()
                                        .catch(error => logTime(`删除旧消息失败: ${error.message}`, true));
                                    await delay(200);
                                }
                                
                                // 每批5条后等待1秒
                                await delay(1000);
                            }
                        }

                        deletedCount += messageBatch.size;

                        // 每删除500条消息更新一次状态
                        if (deletedCount % 500 === 0) {
                            await confirmation.editReply({
                                content: `⏳ 已清理 ${deletedCount} 条消息...`
                            });
                        }

                        // 添加短暂延迟避免触发限制
                        await delay(200);
                    }

                    const executionTime = executionTimer();

                    // 发送完成消息
                    await confirmation.editReply({
                        content: [
                            '✅ 清理完成！',
                            `📊 共清理 ${deletedCount} 条消息`,
                            `⏱️ 执行时间: ${executionTime}秒`
                        ].join('\n'),
                        embeds: [],
                        components: []
                    });

                    // 记录到日志频道
                    if (guildConfig.moderationLogThreadId) {
                        const logChannel = await interaction.client.channels.fetch(guildConfig.moderationLogThreadId);
                        await logChannel.send({
                            embeds: [{
                                color: 0x0099ff,
                                title: '频道清理日志',
                                fields: [
                                    {
                                        name: '操作人',
                                        value: `<@${interaction.user.id}>`,
                                        inline: true
                                    },
                                    {
                                        name: '清理频道',
                                        value: `<#${channel.id}>`,
                                        inline: true
                                    },
                                    {
                                        name: '清理范围',
                                        value: `${endMessage.createdAt.toLocaleString()} 之前的消息`,
                                        inline: false
                                    },
                                    {
                                        name: '清理数量',
                                        value: `${deletedCount} 条消息`,
                                        inline: true
                                    },
                                    {
                                        name: '执行时间',
                                        value: `${executionTime}秒`,
                                        inline: true
                                    }
                                ],
                                timestamp: new Date()
                            }]
                        });
                    }

                    // 记录到控制台日志
                    logTime(`管理员 ${interaction.user.tag} 清理了频道 ${channel.name} 中的 ${deletedCount} 条消息，耗时 ${executionTime}秒`);
                },
                onError: async (error) => {
                    logTime(`清理消息时出错: ${error}`, true);
                    await interaction.editReply({
                        content: '❌ 清理过程中出现错误，请稍后重试。',
                        embeds: [],
                        components: []
                    });
                }
            });
        } catch (error) {
            await handleCommandError(interaction, error, '频道清理');
        }
    },
}; 