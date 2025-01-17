const { SlashCommandBuilder, ChannelType, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { logTime, lockAndArchiveThread, handleCommandError } = require('../utils/helper');
const { handleSingleThread } = require('./mod_prune');
const { globalRequestQueue } = require('../utils/concurrency');

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
                .setName('标注信息')
                .setDescription('标注或取消标注一条消息')
                .addStringOption(option =>
                    option.setName('消息链接') // 消息链接参数是必要的，不可以和操作参数合并！
                        .setDescription('要标注的消息链接')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('操作') // 操作参数是必要的，不可以删除！
                        .setDescription('选择标注或取消标注')
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

                await globalRequestQueue.add(async () => {
                    if (action === 'pin') {
                        await message.pin();
                        await interaction.editReply({
                            content: '✅ 消息已标注'
                        });
                        logTime(`楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
                    } else {
                        await message.unpin();
                        await interaction.editReply({
                            content: '✅ 消息已取消标注'
                        });
                        logTime(`楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
                    }
                }, 2);

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
                    await confirmation.update({
                        content: '⏳ 正在删除帖子...',
                        components: [],
                        embeds: []
                    });

                    try {
                        const threadName = thread.name;
                        const userTag = interaction.user.tag;
                        
                        await globalRequestQueue.add(async () => {
                            await thread.delete('作者自行删除');
                        }, 3);
                        
                        // 记录日志
                        logTime(`楼主 ${userTag} 删除了自己的帖子 ${threadName}`);
                        return;
                    } catch (error) {
                        // 如果删除过程中出现错误，尝试通知用户
                        if (!thread.deleted) {
                            await confirmation.editReply({
                                content: `❌ 删除失败: ${error.message}`,
                                components: [],
                                embeds: []
                            }).catch(() => {
                                // 忽略编辑回复时的错误
                                logTime(`删除帖子失败: ${error.message}`, true);
                            });
                        }
                        throw error;
                    }
                }
            } catch (error) {
                // 只处理未被删除的情况
                if (!thread.deleted) {
                    if (error.code === 'InteractionCollectorError') {
                        await interaction.editReply({
                            embeds: [{
                                color: 0x808080,
                                title: '❌ 确认已超时',
                                description: '删帖操作已取消。如需删除请重新执行命令。',
                            }],
                            components: []
                        }).catch(() => {
                            // 忽略编辑回复时的错误
                        });
                    } else {
                        await handleCommandError(interaction, error, '删除帖子').catch(() => {
                            // 忽略错误处理时的错误
                        });
                    }
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

                    await globalRequestQueue.add(async () => {
                        await lockAndArchiveThread(thread, interaction.user, reason || '作者自行锁定', guildConfig);
                        await interaction.editReply({
                            content: '✅ 帖子已成功锁定并关闭',
                            components: [],
                            embeds: []
                        });
                    }, 3);
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
                const threshold = interaction.options.getInteger('阈值') || 950;
                
                // 先获取当前成员数量
                const members = await thread.members.fetch();
                const memberCount = members.size;
                
                // 如果人数低于阈值,直接返回
                if (memberCount < threshold) {
                    await interaction.editReply({
                        embeds: [{
                            color: 0x808080,
                            title: '❌ 无需清理',
                            description: [
                                `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`
                            ].join('\n')
                        }]
                    });
                    return;
                }

                // 以下是原有的确认逻辑
                const confirmButton = new ButtonBuilder()
                    .setCustomId('confirm_clean')
                    .setLabel('确认清理')
                    .setStyle(ButtonStyle.Danger);

                const row = new ActionRowBuilder()
                    .addComponents(confirmButton);

                const response = await interaction.editReply({
                    embeds: [{
                        color: 0xff0000,
                        title: '⚠️ 清理确认',
                        description: [
                            `你确定要清理帖子 "${thread.name}" 中的不活跃用户吗？`,
                            '',
                            `**⚠️ 此操作将：至少清理：${memberCount - threshold} 人**`,
                            '- 优先移除未发言成员，若不足则会移除发言最少的成员',
                            '- 被移除的成员可以随时重新加入讨论'
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

                        await globalRequestQueue.add(async () => {
                            await handleSingleThread(interaction, guildConfig);
                            logTime(`楼主 ${interaction.user.tag} 清理了帖子 ${thread.name} 中的不活跃用户`);
                        }, 0);
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
