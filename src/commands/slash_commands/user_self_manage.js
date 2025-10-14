import { ActionRowBuilder, ChannelType, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { cleanThreadMembers, sendLogReport, updateThreadAutoCleanupSetting } from '../../services/threadCleaner.js';
import { delay, globalRequestQueue } from '../../utils/concurrency.js';
import { handleConfirmationButton } from '../../utils/confirmationHelper.js';
import { handleCommandError, lockAndArchiveThread } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('自助管理')
        .setDescription('管理你自己的帖子，命令在当前帖子生效')
        .addSubcommand(subcommand => subcommand.setName('删贴').setDescription('删除你的当前这个帖子'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('锁定并关闭')
                .setDescription('锁定并关闭你的帖子（沉底并关闭其他人的回复权限）')
                .addStringOption(option => option.setName('理由').setDescription('锁定原因').setRequired(false)),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('清理不活跃用户')
                .setDescription('清理当前帖子中的不活跃用户')
                .addIntegerOption(option =>
                    option
                        .setName('阈值')
                        .setDescription('目标人数阈值（默认950，最低800）')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false),
                )
                .addBooleanOption(option =>
                    option
                        .setName('启用自动清理')
                        .setDescription('是否启用自动清理功能（默认为是）')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('删除某用户全部消息')
                .setDescription('删除某特定用户在当前帖子的所有消息并将其移出子区（注意：如果帖子消息数量很多，此操作可能需要较长时间）')
                .addUserOption(option =>
                    option
                        .setName('目标用户')
                        .setDescription('要删除其消息的用户')
                        .setRequired(true),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('编辑慢速模式')
                .setDescription('修改当前帖子的慢速模式')
                .addStringOption(option =>
                    option
                        .setName('速度')
                        .setDescription('慢速模式时间间隔')
                        .setRequired(true)
                        .addChoices(
                            { name: '无慢速', value: '0' },
                            { name: '5秒', value: '5' },
                            { name: '10秒', value: '10' },
                            { name: '15秒', value: '15' },
                            { name: '30秒', value: '30' },
                            { name: '1分钟', value: '60' }
                        )
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('移除帖子反应')
                .setDescription('移除你的帖子首楼消息上的反应，切记谨慎操作！')
        ),

    async execute(interaction, guildConfig) {
        const subcommand = interaction.options.getSubcommand();

        // 检查是否在论坛帖子中使用
        if (!interaction.channel.isThread() || !interaction.channel.parent?.type === ChannelType.GuildForum) {
            await interaction.editReply({
                content: '❌ 此命令只能在论坛帖子中使用',
                flags: ['Ephemeral'],
            });
            return;
        }

        const thread = interaction.channel;

        // 检查是否为帖子作者
        if (thread.ownerId !== interaction.user.id) {
            await interaction.editReply({
                content: '❌ 只有帖子作者才能管理此帖子',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 使用switch处理不同的子命令
        switch (subcommand) {
            case '删贴':
                try {
                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_delete',
                        buttonLabel: '确认删贴',
                        embed: {
                            color: 0xff0000,
                            title: '⚠️ 删除确认',
                            description: `你确定要删除帖子 "${
                                thread.name
                            }" 吗？\n\n**⚠️ 警告：此操作不可撤销！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${
                                thread.messageCount
                            }`,
                        },
                        onConfirm: async confirmation => {
                            await confirmation.update({
                                content: '⏳ 正在删除帖子...',
                                components: [],
                                embeds: [],
                            });

                            try {
                                const threadName = thread.name;
                                const userTag = interaction.user.tag;

                                await thread.delete('作者自行删除');

                                // 记录日志
                                logTime(`[自助管理] 楼主 ${userTag} 删除了自己的帖子 ${threadName}`);
                            } catch (error) {
                                // 如果删除过程中出现错误，尝试通知用户
                                if (!thread.deleted) {
                                    await confirmation
                                        .editReply({
                                            content: `❌ 删除失败: ${error.message}`,
                                            components: [],
                                            embeds: [],
                                        })
                                        .catch(() => {
                                            // 忽略编辑回复时的错误
                                            logTime(`删除帖子失败: ${error.message}`, true);
                                        });
                                }
                                throw error;
                            }
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '删除帖子操作已超时。如需继续请重新执行命令。',
                                    }
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            // 只处理未被删除的情况
                            if (!thread.deleted) {
                                await handleCommandError(interaction, error, '删除帖子').catch(() => {
                                    // 忽略错误处理时的错误
                                });
                            }
                        },
                    });
                } catch (error) {
                    // 只处理未被删除的情况
                    if (!thread.deleted) {
                        await handleCommandError(interaction, error, '删除帖子').catch(() => {
                            // 忽略错误处理时的错误
                        });
                    }
                }
                break;

            case '锁定并关闭':
                // 处理锁定并关闭命令
                const reason = interaction.options.getString('理由');
                try {
                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_lock',
                        buttonLabel: '确认锁定',
                        embed: {
                            color: 0xff0000,
                            title: '⚠️ 锁定确认',
                            description: `你确定要锁定并关闭帖子 "${
                                thread.name
                            }" 吗？\n\n**⚠️ 警告：锁定后其他人将无法回复！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${
                                thread.messageCount
                            }\n锁定原因：${reason || '未提供'}`,
                        },
                        onConfirm: async confirmation => {
                            await confirmation.deferUpdate();
                            await interaction.editReply({
                                content: '⏳ 正在锁定帖子...',
                                components: [],
                                embeds: [],
                            });

                            try {
                                await lockAndArchiveThread(thread, interaction.user, reason || '楼主已结束讨论');
                                await interaction.editReply({
                                    content: '✅ 帖子已锁定并归档',
                                    components: [],
                                    embeds: [],
                                });
                            } catch (error) {
                                await handleCommandError(interaction, error, '锁定帖子');
                            }
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '锁定帖子操作已超时。如需继续请重新执行命令。',
                                    }
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '锁定帖子');
                        },
                    });
                } catch (error) {
                    await handleCommandError(interaction, error, '锁定帖子');
                }
                break;

            case '清理不活跃用户':
                // 处理清理不活跃用户命令
                try {
                    const threshold = interaction.options.getInteger('阈值') || 950;
                    const enableAutoCleanup = interaction.options.getBoolean('启用自动清理') ?? true; // 默认为true

                    // 先获取当前成员数量
                    const members = await thread.members.fetch();
                    const memberCount = members.size;

                    // 检查阈值是否大于990
                    if (threshold > 990) {
                        await interaction.editReply({
                            embeds: [
                                {
                                    color: 0xffa500,
                                    title: '⚠️ 阈值提醒',
                                    description: [
                                        `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`,
                                        `自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                                        '此外，当前阈值大于990，因此不会应用到自动清理配置中',
                                        enableAutoCleanup
                                            ? '- 系统将在帖子达到990人时自动清理'
                                            : '- 系统将不会对此帖子进行自动清理',
                                    ].join('\n'),
                                },
                            ],
                        });

                        // 更新自动清理设置（但不保存大于990的阈值）
                        await updateThreadAutoCleanupSetting(thread.id, {
                            enableAutoCleanup: enableAutoCleanup
                            // 不保存 manualThreshold，因为它大于990
                        });
                        return;
                    }

                    // 如果人数低于阈值，检查是否需要更新自动清理设置
                    if (memberCount < threshold) {
                        // 更新自动清理设置
                        await updateThreadAutoCleanupSetting(thread.id, {
                            manualThreshold: threshold,
                            enableAutoCleanup: enableAutoCleanup
                        });

                        await interaction.editReply({
                            embeds: [
                                {
                                    color: 0x808080,
                                    title: '❌ 无需清理',
                                    description: [
                                        `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`,
                                        `自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                                        enableAutoCleanup
                                            ? `- 系统将在帖子达到990人时自动清理至当前设定的阈值(${threshold})`
                                            : '- 系统将不会对此帖子进行自动清理',
                                    ].join('\n'),
                                },
                            ],
                        });
                        return;
                    }

                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_clean',
                        buttonLabel: '确认清理',
                        embed: {
                            color: 0xff0000,
                            title: '⚠️ 清理确认',
                            description: [
                                `你确定要清理帖子 "${thread.name}" 中的不活跃用户吗？`,
                                '',
                                `⚠️ 此操作将：至少清理：${memberCount - threshold} 人`,
                                '- 优先移除未发言成员，若不足则会移除上次发言较早的成员',
                                '- 被移除的成员可以随时重新加入讨论',
                                '',
                                `🤖 自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                                enableAutoCleanup
                                    ? '- 系统将在帖子达到990人时自动清理至设定阈值'
                                    : '- 系统将不会对此帖子进行自动清理',
                            ].join('\n'),
                        },
                        onConfirm: async confirmation => {
                            await confirmation.deferUpdate();

                            try {
                                // 生成任务ID
                                const taskId = `cleanup_${thread.id}_${Date.now()}`;

                                // 添加任务到后台队列
                                await globalRequestQueue.addBackgroundTask({
                                    task: async () => {
                                        // 执行清理任务
                                        const result = await cleanThreadMembers(
                                            thread,
                                            threshold,
                                            {
                                                sendThreadReport: true,
                                                reportType: 'manual',
                                                executor: interaction.user,
                                                taskId,
                                                whitelistedThreads: guildConfig.automation.whitelistedThreads,
                                                manualThreshold: threshold, // 保存用户手动设置的阈值
                                                enableAutoCleanup: enableAutoCleanup // 保存自动清理启用状态
                                            }
                                        );

                                        // 发送管理日志
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
                                    priority: 2, // 较高优先级
                                    threadId: thread.id,
                                    guildId: interaction.guildId
                                });

                                // 通知用户任务已添加到队列
                                await interaction.editReply({
                                    embeds: [{
                                        color: 0x00ff00,
                                        title: '✅ 任务已提交成功',
                                        description: [
                                            '清理任务已添加到后台队列，由于DC API限制，初次执行耗时可能很长，且开始不会有反馈，请耐心等候。',
                                            `**🤖 自动清理状态：${enableAutoCleanup ? '已启用' : '已禁用'}**`,
                                            enableAutoCleanup
                                                ? '• 系统将在帖子达到990人时自动清理至你设定的阈值'
                                                : '• 系统将不会对此帖子进行自动清理',
                                        ].join('\n'),
                                        timestamp: new Date()
                                    }],
                                    components: [],
                                });

                                logTime(`[自助管理] 楼主 ${interaction.user.tag} 提交了清理帖子 ${thread.name} 的后台任务 ${taskId}`);
                            } catch (error) {
                                await interaction.editReply({
                                    content: `❌ 添加清理任务失败: ${error.message}`,
                                    components: [],
                                    embeds: [],
                                });
                                throw error;
                            }
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '清理不活跃用户操作已超时。如需继续请重新执行命令。',
                                    }
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '清理不活跃用户');
                        },
                    });
                } catch (error) {
                    await handleCommandError(interaction, error, '清理不活跃用户');
                }
                break;

            case '删除某用户全部消息':
                try {
                    const targetUser = interaction.options.getUser('目标用户');

                    // 检查目标用户是否为帖子创建者
                    if (targetUser.id === thread.ownerId) {
                        await interaction.editReply({
                            content: '❌ 不能删除你自己的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查目标用户是否为机器人
                    if (targetUser.bot) {
                        await interaction.editReply({
                            content: '❌ 不能删除机器人的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 获取目标用户的身份组
                    const targetMember = await interaction.guild.members.fetch(targetUser.id);

                    // 检查目标用户是否拥有版主权限
                    const moderatorRoles = guildConfig.ModeratorRoleIds || [];
                    const hasModerationRole = targetMember.roles.cache.some(role => moderatorRoles.includes(role.id));

                    if (hasModerationRole) {
                        await interaction.editReply({
                            content: '❌ 不能删除具有管理权限用户的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 确认操作
                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_delete_all_msgs',
                        buttonLabel: '确认删除',
                        embed: {
                            color: 0xff0000,
                            title: '⚠️ 删除确认',
                            description: [
                                `你确定要删除用户 **${targetUser.tag}** 在帖子 "${thread.name}" 中的所有消息吗？`,
                                '',
                                '**⚠️ 警告：**',
                                '- 此操作不可撤销，将删除该用户的所有消息并将其移出子区。',
                                '- 如果帖子消息数量很多，此操作可能需要较长时间，最大扫描上限为10000条。'
                            ].join('\n'),
                        },
                        onConfirm: async confirmation => {
                            await confirmation.deferUpdate();
                            await interaction.editReply({
                                content: '⏳ 正在扫描消息...',
                                components: [],
                                embeds: [],
                            });

                            const MAX_MESSAGES_TO_SCAN = 3000;
                            let lastId = null;
                            let messagesProcessed = 0;
                            let deletedCount = 0;
                            let hasMoreMessages = true;
                            let limitReached = false;

                            /**
                             * 更新操作进度
                             * @param {string} status - 当前状态
                             */
                            const updateProgress = async (status = '处理中') => {
                                await interaction.editReply({
                                    content: `⏳ ${status} ${targetUser.tag} 的消息...已扫描: ${messagesProcessed} 条 (上限 ${MAX_MESSAGES_TO_SCAN}) 已删除: ${deletedCount} 条`,
                                    components: [],
                                    embeds: [],
                                });
                            };

                            try {
                                while (hasMoreMessages) {
                                    // 更新获取消息批次前的进度
                                    await updateProgress('正在获取');

                                    // 获取消息批次
                                    const options = { limit: 100 };
                                    if (lastId) options.before = lastId;
                                    const messages = await thread.messages.fetch(options);

                                    if (messages.size === 0) {
                                        hasMoreMessages = false;
                                        continue;
                                    }

                                    // 更新消息处理记录
                                    messagesProcessed += messages.size;
                                    lastId = messages.last().id;

                                    // 新增：检查是否达到扫描上限
                                    if (messagesProcessed >= MAX_MESSAGES_TO_SCAN) {
                                        hasMoreMessages = false; // 停止获取更多消息
                                        limitReached = true;    // 标记已达到上限
                                        logTime(`[自助管理] 帖子 ${thread.name} 中删除用户 ${targetUser.tag} 消息时达到 ${MAX_MESSAGES_TO_SCAN} 条扫描上限。已扫描 ${messagesProcessed} 条。`);
                                    }

                                    // 更新获取消息后的进度
                                    await updateProgress('正在处理');

                                    // 添加延迟避免API限制
                                    await delay(800);

                                    // 筛选并删除目标用户的消息
                                    const targetMessages = messages.filter(msg => msg.author.id === targetUser.id);

                                    for (const message of targetMessages.values()) {
                                        try {
                                            await message.delete();
                                            deletedCount++;

                                            // 每删除10条消息更新一次进度
                                            if (deletedCount % 10 === 0) {
                                                await updateProgress('正在删除');
                                            }

                                            // 添加延迟避免API限制
                                            await delay(1000);
                                        } catch (error) {
                                            logTime(`删除用户消息失败 (${message.id}): ${error.message}`, true);
                                        }
                                    }
                                    //如果因为达到上限而停止，确保最后一次进度更新
                                    if (limitReached && !hasMoreMessages) {
                                        await updateProgress('已达到扫描上限，正在完成当前批次删除');
                                    }
                                }

                                // 尝试移除用户
                                try {
                                    await thread.members.remove(targetUser.id);

                                    //根据是否达到上限更新最终结果
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
                            } catch (error) {
                                await handleCommandError(interaction, error, '删除用户全部消息');
                            }
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '删除用户全部消息操作已超时。如需继续请重新执行命令。',
                                    }
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '删除用户全部消息');
                        },
                    });
                } catch (error) {
                    await handleCommandError(interaction, error, '删除用户全部消息');
                }
                break;

            case '编辑慢速模式':
                try {
                    const speed = interaction.options.getString('速度');
                    if (!speed || !['0', '5', '10', '15', '30', '60'].includes(speed)) {
                        await interaction.editReply({
                            content: '❌ 无效的速度选择',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    const oldSlowMode = thread.rateLimitPerUser || 0;
                    const newSlowMode = parseInt(speed);
                    await thread.setRateLimitPerUser(newSlowMode);
                    await interaction.editReply({
                        content: '✅ 帖子慢速模式已更新',
                        flags: ['Ephemeral'],
                    });
                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 更新了帖子 ${thread.name} 的慢速模式：${oldSlowMode}秒 -> ${newSlowMode}秒`);
                } catch (error) {
                    await handleCommandError(interaction, error, '更新帖子慢速模式');
                }
                break;

            case '移除帖子反应':
                try {
                    // 获取帖子首楼消息
                    const starterMessage = await thread.fetchStarterMessage();

                    if (!starterMessage) {
                        await interaction.editReply({
                            content: '❌ 无法获取帖子首楼消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查消息是否有反应
                    if (starterMessage.reactions.cache.size === 0) {
                        await interaction.editReply({
                            content: '❌ 帖子首楼没有任何反应',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 构建选择菜单选项
                    const options = [
                        {
                            label: '全部',
                            description: '移除所有反应',
                            value: 'all',
                            emoji: '🗑️',
                        }
                    ];

                    // 添加每个单独的反应选项
                    for (const [emoji, reaction] of starterMessage.reactions.cache) {
                        options.push({
                            label: `${reaction.emoji.name || emoji}`,
                            description: `${reaction.count} 个反应`,
                            value: emoji,
                            emoji: reaction.emoji.id ? { id: reaction.emoji.id } : reaction.emoji.name,
                        });
                    }

                    // 创建选择菜单
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`remove_reaction_${starterMessage.id}_${interaction.user.id}`)
                        .setPlaceholder('选择要移除的反应')
                        .addOptions(options);

                    const row = new ActionRowBuilder().addComponents(selectMenu);

                    // 回复用户
                    await interaction.editReply({
                        content: '请选择要移除的反应：',
                        components: [row],
                        flags: ['Ephemeral'],
                    });

                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 请求移除帖子 ${thread.name} 首楼的反应`);
                } catch (error) {
                    await handleCommandError(interaction, error, '移除帖子反应');
                }
                break;
        }
    },
};
