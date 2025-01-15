const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { checkPermission, handlePermissionResult, logTime } = require('../utils/common');

/**
 * 重整命令 - 清理子区未发言成员
 * 将子区人数控制在750以下，优先移除未发言成员
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('重整人数')
        .setDescription('清理子区未发言成员，控制人数在指定阈值以下')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option =>
            option.setName('阈值')
                .setDescription('目标人数阈值(默认950)')
                .setMinValue(800)
                .setMaxValue(1000)
                .setRequired(false)),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        // 验证当前频道是否为论坛帖子
        if (!interaction.channel.isThread()) {
            await interaction.reply({
                content: '❌ 此命令只能在帖子中使用',
                flags: ['Ephemeral']
            });
            return;
        }

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            const thread = interaction.channel;
            
            // 默认阈值为950
            const threshold = interaction.options.getInteger('阈值') || 950;
            
            // 获取完整的成员列表
            const members = await thread.members.fetch();
            const memberCount = members.size;

            // 如果人数已经低于阈值，无需处理
            if (memberCount <= threshold) {
                await interaction.editReply({
                    content: `✅ 当前子区人数(${memberCount})已经在限制范围内，无需重整。`,
                    flags: ['Ephemeral']
                });
                return;
            }

            // 获取所有消息以统计发言用户
            const activeUsers = new Set();
            let lastId;
            let messagesProcessed = 0;

            // 使用异步并行批处理获取消息历史
            async function fetchMessagesBatch(beforeId) {
                const options = { limit: 100 };
                if (beforeId) options.before = beforeId;
                
                try {
                    const messages = await thread.messages.fetch(options);
                    messages.forEach(msg => activeUsers.add(msg.author.id));
                    return messages;
                } catch (error) {
                    logTime(`获取消息批次失败: ${error.message}`, true);
                    return null;
                }
            }

            while (true) {
                // 创建10个并行批次
                const batchPromises = [];
                for (let i = 0; i < 10; i++) {
                    if (i === 0) {
                        batchPromises.push(fetchMessagesBatch(lastId));
                    } else {
                        // 等待前一个批次的lastId
                        const prevBatch = await batchPromises[i - 1];
                        if (!prevBatch || prevBatch.size === 0) {
                            break;
                        }
                        batchPromises.push(fetchMessagesBatch(prevBatch.last().id));
                    }
                }

                if (batchPromises.length === 0) break;

                // 等待所有批次完成
                const results = await Promise.all(batchPromises);
                
                // 统计处理的消息数量
                let batchMessagesCount = 0;
                for (const messages of results) {
                    if (messages && messages.size > 0) {
                        batchMessagesCount += messages.size;
                        lastId = messages.last().id;
                    }
                }

                if (batchMessagesCount === 0) break;
                
                messagesProcessed += batchMessagesCount;
                
                // 更新进度
                await interaction.editReply({
                    content: `正在统计活跃用户...已处理 ${messagesProcessed} 条消息`,
                    flags: ['Ephemeral']
                });
            }

            // 找出未发言的成员
            const inactiveMembers = members.filter(member => !activeUsers.has(member.id));
            const needToRemove = memberCount - threshold;
            const toRemove = Array.from(inactiveMembers.values()).slice(0, needToRemove);

            // 使用5个一组的并行批处理来移除成员
            let removedCount = 0;
            let failedCount = 0;

            // 将成员分组，每组5个
            for (let i = 0; i < toRemove.length; i += 5) {
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

                // 等待当前批次完成
                const results = await Promise.all(removePromises);
                
                // 统计结果
                removedCount += results.filter(success => success).length;
                failedCount += results.filter(success => !success).length;

                // 更新进度
                await interaction.editReply({
                    content: `正在移除未发言成员...${removedCount}/${toRemove.length}`,
                    flags: ['Ephemeral']
                });
            }

            // 发送操作日志到管理频道
            const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
            await moderationChannel.send({
                embeds: [{
                    color: 0x0099ff,
                    title: '子区人数重整',
                    fields: [
                        {
                            name: '操作人',
                            value: `<@${interaction.user.id}>`,
                            inline: true
                        },
                        {
                            name: '子区',
                            value: `[${thread.name}](${thread.url})`,
                            inline: true
                        },
                        {
                            name: '统计结果',
                            value: [
                                `目标阈值: ${threshold}`,
                                `原始人数: ${memberCount}`,
                                `活跃用户: ${activeUsers.size}`,
                                `已移除: ${removedCount}`,
                                `移除失败: ${failedCount}`
                            ].join('\n'),
                            inline: false
                        }
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: '论坛管理系统'
                    }
                }]
            });

            // 在子区发送通知
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
                                `目标阈值: ${threshold}`,
                                `原始人数: ${memberCount}`,
                                `移除人数: ${removedCount}`,
                                `当前人数: ${memberCount - removedCount}`
                            ].join('\n'),
                            inline: false
                        }
                    ],
                    timestamp: new Date()
                }]
            });

            // 完成回复
            await interaction.editReply({
                content: [
                    '✅ 子区人数重整完成！',
                    `🎯 目标阈值: ${threshold}`,
                    `📊 原始人数: ${memberCount}`,
                    `👥 活跃用户: ${activeUsers.size}`,
                    `🚫 已移除: ${removedCount}`,
                    `❌ 移除失败: ${failedCount}`,
                    `👤 当前人数: ${memberCount - removedCount}`
                ].join('\n'),
                flags: ['Ephemeral']
            });

            logTime(`用户 ${interaction.user.tag} 完成子区 ${thread.name} 的人数重整`);

        } catch (error) {
            logTime(`重整子区人数时出错: ${error}`, true);
            await interaction.editReply({
                content: `❌ 执行重整时出错: ${error.message}`,
                flags: ['Ephemeral']
            });
        }
    },
}; 