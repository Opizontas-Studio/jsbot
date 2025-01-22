import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { lockAndArchiveThread, handleCommandError } from '../utils/helper.js';
import { handleSingleThreadCleanup } from '../services/cleaner.js';
import { logTime } from '../utils/logger.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../handlers/buttons.js';

export default {
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
	                        { name: '取消标注', value: 'unpin' },
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
	            flags: ['Ephemeral'],
	        });
	        return;
	    }

	    const thread = interaction.channel;

	    // 检查是否为帖子作者
	    if (thread.ownerId !== interaction.user.id) {
	        await interaction.reply({
	            content: '❌ 只有帖子作者才能管理此帖子',
	            flags: ['Ephemeral'],
	        });
	        return;
	    }

	    // 处理标注信息命令
	    if (subcommand === '标注信息') {
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

	            const [, channelId, messageId] = matches;
	            const channel = await interaction.client.channels.fetch(channelId);
	            const message = await channel.messages.fetch(messageId);

	            if (!message) {
	                await interaction.editReply({
	                    content: '❌ 找不到指定的消息',
	                });
	                return;
	            }

	            await interaction.editReply({
	                content: '⏳ 正在处理...',
	            });

	            if (action === 'pin') {
	                await message.pin();
	                await interaction.editReply({
	                    content: '✅ 消息已标注',
	                });
	                logTime(`楼主 ${interaction.user.tag} 标注了帖子 ${thread.name} 中的一条消息`);
	            }
				else {
	                await message.unpin();
	                await interaction.editReply({
	                    content: '✅ 消息已取消标注',
	                });
	                logTime(`楼主 ${interaction.user.tag} 取消标注了帖子 ${thread.name} 中的一条消息`);
	            }

	        }
			catch (error) {
	            await handleCommandError(interaction, error, '标注消息');
	        }
	        return;
	    }

	    // 处理删除命令
	    if (subcommand === '删除') {
	        try {
	            await handleConfirmationButton({
	                interaction,
	                customId: 'confirm_delete',
	                buttonLabel: '确认删除',
	                embed: {
	                    color: 0xff0000,
	                    title: '⚠️ 删除确认',
	                    description: `你确定要删除帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：此操作不可撤销！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}`,
	                },
	                onConfirm: async (confirmation) => {
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
	                        logTime(`楼主 ${userTag} 删除了自己的帖子 ${threadName}`);
	                    }
						catch (error) {
	                        // 如果删除过程中出现错误，尝试通知用户
	                        if (!thread.deleted) {
	                            await confirmation.editReply({
	                                content: `❌ 删除失败: ${error.message}`,
	                                components: [],
	                                embeds: [],
	                            }).catch(() => {
	                                // 忽略编辑回复时的错误
	                                logTime(`删除帖子失败: ${error.message}`, true);
	                            });
	                        }
	                        throw error;
	                    }
	                },
	                onError: async (error) => {
	                    // 只处理未被删除的情况
	                    if (!thread.deleted) {
	                        await handleCommandError(interaction, error, '删除帖子').catch(() => {
	                            // 忽略错误处理时的错误
	                        });
	                    }
	                },
	            });
	        }
			catch (error) {
	            // 只处理未被删除的情况
	            if (!thread.deleted) {
	                await handleCommandError(interaction, error, '删除帖子').catch(() => {
	                    // 忽略错误处理时的错误
	                });
	            }
	        }
	    }
	    // 处理锁定并关闭命令
	    else if (subcommand === '锁定并关闭') {
	        const reason = interaction.options.getString('理由');
	        try {
	            await handleConfirmationButton({
	                interaction,
	                customId: 'confirm_lock',
	                buttonLabel: '确认锁定',
	                embed: {
	                    color: 0xff0000,
	                    title: '⚠️ 锁定确认',
	                    description: `你确定要锁定并关闭帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：锁定后其他人将无法回复！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}\n锁定原因：${reason || '未提供'}`,
	                },
	                onConfirm: async (confirmation) => {
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
	                    }
						catch (error) {
	                        await handleCommandError(interaction, error, '锁定帖子');
	                    }
	                },
	                onError: async (error) => {
	                    await handleCommandError(interaction, error, '锁定帖子');
	                },
	            });
	        }
			catch (error) {
	            await handleCommandError(interaction, error, '锁定帖子');
	        }
	    }
	    // 处理清理不活跃用户命令
	    else if (subcommand === '清理不活跃用户') {
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
	                            `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`,
	                        ].join('\n'),
	                    }],
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
	                onConfirm: async (confirmation) => {
	                    await confirmation.deferUpdate();
	                    await interaction.editReply({
	                        content: '⏳ 正在开始清理...',
	                        components: [],
	                        embeds: [],
	                    });

	                    await globalRequestQueue.add(async () => {
	                        await handleSingleThreadCleanup(interaction, guildConfig);
	                        logTime(`楼主 ${interaction.user.tag} 清理了帖子 ${thread.name} 中的不活跃用户`);
	                    }, 0); // 该耗时任务独立进入队列
	                },
	                onError: async (error) => {
	                    await handleCommandError(interaction, error, '清理不活跃用户');
	                },
	            });
	        }
			catch (error) {
	            await handleCommandError(interaction, error, '清理不活跃用户');
	        }
	    }
	},
};
