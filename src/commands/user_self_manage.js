import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { handleSingleThreadCleanup } from '../services/threadCleaner.js';
import { delay } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { handleCommandError, lockAndArchiveThread } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
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
                .setName('标注信息')
                .setDescription('标注或取消标注一条消息')
                .addStringOption(option =>
                    option
                        .setName('消息链接') // 消息链接参数是必要的，不可以和操作参数合并！
                        .setDescription('要标注的消息链接')
                        .setRequired(true),
                )
                .addStringOption(option =>
                    option
                        .setName('操作') // 操作参数是必要的，不可以删除！
                        .setDescription('选择标注或取消标注')
                        .setRequired(true)
                        .addChoices({ name: '标注', value: 'pin' }, { name: '取消标注', value: 'unpin' }),
                ),
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
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('删除消息')
                .setDescription('删除当前帖子内指定的一条消息（可删除其他人发送的消息）')
                .addStringOption(option =>
                    option
                        .setName('消息链接')
                        .setDescription('要删除的消息链接')
                        .setRequired(true),
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
                .setName('编辑标题')
                .setDescription('修改当前帖子的标题')
                .addStringOption(option =>
                    option
                        .setName('新标题')
                        .setDescription('帖子的新标题')
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(100)
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
            case '标注信息':
                try {
                    const messageUrl = interaction.options.getString('消息链接');
                    const action = interaction.options.getString('操作');

                    const matches = messageUrl.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
                    if (!matches) {
                        await interaction.editReply({
                            content: '❌ 无效的消息链接格式',
                        });
                        return;
                    }

                    const [, guildId, channelId, messageId] = matches;

                    // 验证消息是否在当前服务器
                    if (guildId !== interaction.guildId) {
                        await interaction.editReply({
                            content: '❌ 只能标注当前服务器的消息',
                        });
                        return;
                    }

                    // 验证消息是否在当前帖子
                    if (channelId !== interaction.channelId) {
                        await interaction.editReply({
                            content: '❌ 只能标注当前帖子内的消息',
                        });
                        return;
                    }

                    try {
                        const message = await interaction.channel.messages.fetch(messageId);

                        if (!message) {
                            await interaction.editReply({
                                content: '❌ 找不到指定的消息',
                            });
                            return;
                        }

                        if (action === 'pin') {
                            await message.pin();
                            await interaction.editReply({
                                content: '✅ 消息已标注',
                            });
                            logTime(`[自助管理] 楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                        } else {
                            await message.unpin();
                            await interaction.editReply({
                                content: '✅ 消息已取消标注',
                            });
                            logTime(`[自助管理] 楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                        }
                    } catch (error) {
                        await interaction.editReply({
                            content: `❌ 标注操作失败: ${error.message}`,
                        });
                        throw error;
                    }
                } catch (error) {
                    await handleCommandError(interaction, error, '标注消息');
                }
                break;

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

                    // 先获取当前成员数量
                    const members = await thread.members.fetch();
                    const memberCount = members.size;

                    // 如果人数低于阈值,直接返回
                    if (memberCount < threshold) {
                        await interaction.editReply({
                            embeds: [
                                {
                                    color: 0x808080,
                                    title: '❌ 无需清理',
                                    description: [`当前帖子人数(${memberCount})未达到清理阈值(${threshold})`].join('\n'),
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
                                `**⚠️ 此操作将：至少清理：${memberCount - threshold} 人**`,
                                '- 优先移除未发言成员，若不足则会移除发言最少的成员',
                                '- 被移除的成员可以随时重新加入讨论',
                            ].join('\n'),
                        },
                        onConfirm: async confirmation => {
                            await confirmation.deferUpdate();
                            await interaction.editReply({
                                content: '⏳ 正在开始清理...',
                                components: [],
                                embeds: [],
                            });

                            // 执行清理
                            await handleSingleThreadCleanup(interaction, guildConfig);
                            logTime(`[自助管理] 楼主 ${interaction.user.tag} 清理了帖子 ${thread.name} 中的不活跃用户`);
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

            case '删除消息':
                try {
                    const messageUrl = interaction.options.getString('消息链接');
                    const matches = messageUrl.match(/channels\/(\d+)\/(\d+)\/(\d+)/);

                    if (!matches) {
                        await interaction.editReply({
                            content: '❌ 无效的消息链接格式',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    const [, guildId, channelId, messageId] = matches;

                    // 验证消息是否在当前服务器和当前帖子
                    if (guildId !== interaction.guildId || channelId !== interaction.channelId) {
                        await interaction.editReply({
                            content: '❌ 只能删除当前帖子内的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    try {
                        const message = await interaction.channel.messages.fetch(messageId);
                        if (!message) {
                            await interaction.editReply({
                                content: '❌ 找不到指定的消息',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }

                        // 保存消息内容和发送者信息用于日志
                        const messageContent = message.content;
                        const messageAuthor = message.author;

                        // 删除消息
                        await message.delete();

                        await interaction.editReply({
                            content: `✅ 已删除 ${messageAuthor.tag} 发送的消息`,
                            flags: ['Ephemeral'],
                        });

                        // 记录日志
                        logTime(`[自助管理] 楼主 ${interaction.user.tag} 在帖子 ${thread.name} 中删除了 ${messageAuthor.tag} 发送的消息，内容：${messageContent}`);
                    } catch (error) {
                        await interaction.editReply({
                            content: `❌ 删除消息失败: ${error.message}`,
                            flags: ['Ephemeral'],
                        });
                        throw error;
                    }
                } catch (error) {
                    await handleCommandError(interaction, error, '删除消息');
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

                            const MAX_MESSAGES_TO_SCAN = 15000; // 新增：定义最大扫描消息数量
                            let lastId = null;
                            let messagesProcessed = 0;
                            let deletedCount = 0;
                            let hasMoreMessages = true;
                            let limitReached = false; // 新增：标记是否达到扫描上限

                            /**
                             * 更新操作进度
                             * @param {string} status - 当前状态
                             */
                            const updateProgress = async (status = '处理中') => {
                                await interaction.editReply({
                                    content: `⏳ ${status} ${targetUser.tag} 的消息...
已扫描: ${messagesProcessed} 条 (上限 ${MAX_MESSAGES_TO_SCAN})
已删除: ${deletedCount} 条`, // 修改：增加上限提示
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
                                    // 新增：如果因为达到上限而停止，确保最后一次进度更新
                                    if (limitReached && !hasMoreMessages) { // 确保只在循环即将结束时调用
                                        await updateProgress('已达到扫描上限，正在完成当前批次删除');
                                    }
                                }

                                // 尝试移除用户
                                try {
                                    await thread.members.remove(targetUser.id);

                                    // 修改：根据是否达到上限更新最终结果
                                    const finalMessage = limitReached
                                        ? `✅ 已扫描 ${messagesProcessed} 条消息（达到上限）。已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区。`
                                        : `✅ 已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区`;
                                    await interaction.editReply({
                                        content: finalMessage,
                                        components: [],
                                        embeds: [],
                                    });

                                    // 修改：更新日志记录
                                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 删除了用户 ${targetUser.tag} 在帖子 ${thread.name} 中的 ${deletedCount} 条消息并将其移出子区${limitReached ? ` (扫描达到 ${MAX_MESSAGES_TO_SCAN} 条上限，共扫描 ${messagesProcessed} 条)` : ''}`);
                                } catch (error) {
                                    // 修改：根据是否达到上限更新结果，但报告移除成员失败
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

            case '编辑标题':
                try {
                    const newTitle = interaction.options.getString('新标题');
                    if (!newTitle || newTitle.length < 1 || newTitle.length > 100) {
                        await interaction.editReply({
                            content: '❌ 新标题长度必须在1到100个字符之间',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    const oldTitle = thread.name;
                    await thread.setName(newTitle);
                    await interaction.editReply({
                        content: '✅ 帖子标题已更新',
                        flags: ['Ephemeral'],
                    });
                    logTime(`[自助管理] 楼主 ${interaction.user.tag} 更新了帖子标题：${oldTitle} -> ${newTitle}`);
                } catch (error) {
                    await handleCommandError(interaction, error, '更新帖子标题');
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
        }
    },
};
