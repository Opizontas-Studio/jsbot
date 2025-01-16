const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { logTime, lockAndArchiveThread, handleCommandError } = require('../utils/helper');
const { handleSingleThread } = require('./mod_prune');
const { globalRateLimiter } = require('../utils/concurrency');

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('自助管理')
        .setDescription('管理你自己的帖子')
        .addSubcommand(subcommand =>
            subcommand
                .setName('删除')
                .setDescription('删除你的帖子'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('锁定并关闭')
                .setDescription('锁定并关闭你的帖子')
                .addStringOption(option =>
                    option.setName('理由')
                        .setDescription('锁定原因')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('打开并解锁')
                .setDescription('打开并解锁一个帖子')
                .addStringOption(option =>
                    option.setName('帖子链接')
                        .setDescription('要打开的帖子链接')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('标注信息')
                .setDescription('标注或取消标注一条消息')
                .addStringOption(option =>
                    option.setName('消息链接')
                        .setDescription('要标注的消息链接')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('操作')
                        .setDescription('选择要执行的操作')
                        .setRequired(true)
                        .addChoices(
                            { name: '标注', value: 'pin' },
                            { name: '取消标注', value: 'unpin' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('清理不活跃用户')
                .setDescription('清理当前帖子中的不活跃用户')
                .addIntegerOption(option =>
                    option.setName('阈值')
                        .setDescription('目标人数阈值(默认950)')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false))),

    async execute(interaction, guildConfig) {
        const subcommand = interaction.options.getSubcommand();

        // 特殊处理：打开并解锁命令（允许跨帖子操作）
        if (subcommand === '打开并解锁') {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            
            try {
                const threadUrl = interaction.options.getString('帖子链接');
                const matches = threadUrl.match(/channels\/(\d+)\/(\d+)(?:\/threads\/(\d+))?/);
                
                if (!matches) {
                    await interaction.editReply({
                        content: '❌ 无效的帖子链接格式'
                    });
                    return;
                }

                const [, guildId, channelId, threadId] = matches;
                const targetThreadId = threadId || channelId;
                
                const thread = await interaction.client.channels.fetch(targetThreadId);

                if (!thread || !thread.isThread()) {
                    await interaction.editReply({
                        content: '❌ 找不到指定的帖子'
                    });
                    return;
                }

                // 检查是否为帖子作者
                if (thread.ownerId !== interaction.user.id) {
                    await interaction.editReply({
                        content: '❌ 只有帖子作者才能管理此帖子'
                    });
                    return;
                }

                await thread.setArchived(false);
                await thread.setLocked(false);
                
                await interaction.editReply({
                    content: '✅ 帖子已成功打开并解锁'
                });
                logTime(`用户 ${interaction.user.tag} 打开并解锁了帖子 ${thread.name}`);

            } catch (error) {
                await handleCommandError(interaction, error, '打开帖子');
            }
            return;
        }

        // 检查是否在论坛帖子中使用
        if (!interaction.channel.isThread() || 
            !interaction.channel.parent?.type === ChannelType.GuildForum) {
            await interaction.reply({
                content: '❌ 此命令只能在论坛帖子中使用',
                flags: ['Ephemeral']
            });
            return;
        }

        const thread = interaction.channel;
        
        // 检查是否为帖子作者
        if (thread.ownerId !== interaction.user.id) {
            await interaction.reply({
                content: '❌ 只有帖子作者才能管理此帖子',
                flags: ['Ephemeral']
            });
            return;
        }

        // 处理标注信息命令
        if (subcommand === '标注信息') {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            
            try {
                const messageUrl = interaction.options.getString('消息链接');
                const action = interaction.options.getString('操作');
                
                const matches = messageUrl.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
                if (!matches) {
                    await interaction.editReply({
                        content: '❌ 无效的消息链接格式'
                    });
                    return;
                }

                const [, guildId, channelId, messageId] = matches;
                const channel = await interaction.client.channels.fetch(channelId);
                const message = await channel.messages.fetch(messageId);

                if (!message) {
                    await interaction.editReply({
                        content: '❌ 找不到指定的消息'
                    });
                    return;
                }

                await interaction.editReply({
                    content: '⏳ 正在处理...'
                });

                await globalRateLimiter.withRateLimit(async () => {
                    if (action === 'pin') {
                        await message.pin();
                        await interaction.editReply({
                            content: '✅ 消息已标注'
                        });
                        logTime(`用户 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                    } else {
                        await message.unpin();
                        await interaction.editReply({
                            content: '✅ 消息已取消标注'
                        });
                        logTime(`用户 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                    }
                });

            } catch (error) {
                await handleCommandError(interaction, error, '标注消息');
            }
            return;
        }

        // 处理删除命令
        if (subcommand === '删除') {
            await interaction.deferReply({ flags: ['Ephemeral'] });

            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_delete')
                .setLabel('确认删除')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder()
                .addComponents(confirmButton);

            const response = await interaction.editReply({
                embeds: [{
                    color: 0xff0000,
                    title: '⚠️ 删除确认',
                    description: `你确定要删除帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：此操作不可撤销！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}`,
                    footer: {
                        text: '此确认按钮将在5分钟后失效'
                    }
                }],
                components: [row]
            });

            try {
                const confirmation = await response.awaitMessageComponent({
                    filter: i => i.user.id === interaction.user.id,
                    time: 300000
                });

                if (confirmation.customId === 'confirm_delete') {
                    await confirmation.deferUpdate();
                    await interaction.editReply({
                        content: '⏳ 正在删除帖子...',
                        components: [],
                        embeds: []
                    });

                    await globalRateLimiter.withRateLimit(async () => {
                        await thread.delete('作者自行删除');
                        await interaction.editReply({
                            content: '✅ 帖子已成功删除',
                            components: [],
                            embeds: []
                        });
                        logTime(`用户 ${interaction.user.tag} 删除了自己的帖子 ${thread.name}`);
                    });
                }
            } catch (error) {
                if (error.code === 'InteractionCollectorError') {
                    await interaction.editReply({
                        embeds: [{
                            color: 0x808080,
                            title: '❌ 确认已超时',
                            description: '删帖操作已取消。如需删除请重新执行命令。',
                        }],
                        components: []
                    });
                } else {
                    await handleCommandError(interaction, error, '删除帖子');
                }
            }
        } 
        // 处理锁定并关闭命令
        else if (subcommand === '锁定并关闭') {
            const reason = interaction.options.getString('理由');
            await interaction.deferReply({ flags: ['Ephemeral'] });
            
            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_lock')
                .setLabel('确认锁定')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder()
                .addComponents(confirmButton);

            const response = await interaction.editReply({
                embeds: [{
                    color: 0xff0000,
                    title: '⚠️ 锁定确认',
                    description: `你确定要锁定并关闭帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：锁定后其他人将无法回复！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}\n锁定原因：${reason || '未提供'}`,
                    footer: {
                        text: '此确认按钮将在5分钟后失效'
                    }
                }],
                components: [row]
            });

            try {
                const confirmation = await response.awaitMessageComponent({
                    filter: i => i.user.id === interaction.user.id,
                    time: 300000
                });

                if (confirmation.customId === 'confirm_lock') {
                    await confirmation.deferUpdate();
                    await interaction.editReply({
                        content: '⏳ 正在锁定帖子...',
                        components: [],
                        embeds: []
                    });

                    await globalRateLimiter.withRateLimit(async () => {
                        await lockAndArchiveThread(thread, interaction.user, reason || '作者自行锁定', guildConfig);
                        await interaction.editReply({
                            content: '✅ 帖子已成功锁定并关闭',
                            components: [],
                            embeds: []
                        });
                        logTime(`用户 ${interaction.user.tag} 锁定并关闭了帖子 ${thread.name}`);
                    });
                }
            } catch (error) {
                if (error.code === 'InteractionCollectorError') {
                    await interaction.editReply({
                        embeds: [{
                            color: 0x808080,
                            title: '❌ 确认已超时',
                            description: '锁定操作已取消。如需锁定请重新执行命令。',
                        }],
                        components: []
                    });
                } else {
                    await handleCommandError(interaction, error, '锁定帖子');
                }
            }
        }
        // 处理清理不活跃用户命令
        else if (subcommand === '清理不活跃用户') {
            await interaction.deferReply({ flags: ['Ephemeral'] });

            try {
                const confirmButton = new ButtonBuilder()
                    .setCustomId('confirm_clean')
                    .setLabel('确认清理')
                    .setStyle(ButtonStyle.Danger);

                const row = new ActionRowBuilder()
                    .addComponents(confirmButton);

                const threshold = interaction.options.getInteger('阈值') || 950;

                const response = await interaction.editReply({
                    embeds: [{
                        color: 0xff0000,
                        title: '⚠️ 清理确认',
                        description: [
                            `你确定要清理帖子 "${thread.name}" 中的不活跃用户吗？`,
                            '',
                            '**⚠️ 此操作将：**',
                            `- 移除未发言成员，直到人数低于 ${threshold}`,
                            '- 如果未发言成员不足，则会移除发言最少的成员',
                            '',
                            '**注意：被移除的成员可以随时重新加入讨论**'
                        ].join('\n'),
                        footer: {
                            text: '此确认按钮将在5分钟后失效'
                        }
                    }],
                    components: [row]
                });

                try {
                    const confirmation = await response.awaitMessageComponent({
                        filter: i => i.user.id === interaction.user.id,
                        time: 300000
                    });

                    if (confirmation.customId === 'confirm_clean') {
                        await confirmation.deferUpdate();
                        await interaction.editReply({
                            content: '⏳ 正在开始清理...',
                            components: [],
                            embeds: []
                        });

                        await globalRateLimiter.withRateLimit(async () => {
                            await handleSingleThread(interaction, guildConfig);
                            logTime(`用户 ${interaction.user.tag} 清理了帖子 ${thread.name} 中的不活跃用户`);
                        });
                    }
                } catch (error) {
                    if (error.code === 'InteractionCollectorError') {
                        await interaction.editReply({
                            embeds: [{
                                color: 0x808080,
                                title: '❌ 确认已超时',
                                description: '清理操作已取消。如需清理请重新执行命令。',
                            }],
                            components: []
                        });
                    } else {
                        throw error;
                    }
                }
            } catch (error) {
                await handleCommandError(interaction, error, '清理不活跃用户');
            }
        }
    },
};
