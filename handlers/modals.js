import { logTime } from '../utils/logger.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { ChannelType } from 'discord.js';
import { DiscordAPIError } from '@discordjs/rest';
import { handleDiscordError } from '../utils/helper.js';

/**
 * 模态框处理器映射
 * 每个处理器函数接收一个 ModalSubmitInteraction 参数
 */
export const modalHandlers = {
	// 身份组申请模态框处理器
	'creator_role_modal': async (interaction) => {
	    try {
	        await interaction.deferReply({ flags: ['Ephemeral'] });

	        const threadLink = interaction.fields.getTextInputValue('thread_link');
	        const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);

	        if (!matches) {
	            await interaction.editReply('❌ 无效的帖子链接格式');
	            return;
	        }

	        const [, linkGuildId, threadId] = matches;
	        const currentGuildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

	        // 检查当前服务器是否启用功能
	        if (!currentGuildConfig?.roleApplication?.enabled) {
	            await interaction.editReply('❌ 此服务器未启用身份组申请功能');
	            return;
	        }

	        if (!currentGuildConfig?.roleApplication?.creatorRoleId) {
	            await interaction.editReply('❌ 服务器配置错误');
	            return;
	        }

	        // 检查链接所属服务器是否在配置中
	        const linkGuildConfig = interaction.client.guildManager.getGuildConfig(linkGuildId);
	        if (!linkGuildConfig) {
	            await interaction.editReply('❌ 提供的帖子不在允许的服务器中');
	            return;
	        }

	        await globalRequestQueue.add(async () => {
	            const thread = await interaction.client.channels.fetch(threadId);

	            if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
	                await interaction.editReply('❌ 提供的链接不是论坛帖子');
	                return;
	            }

	            // 获取首条消息
	            const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
	            const threadStarter = firstMessage.first();

	            if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
	                await interaction.editReply('❌ 您不是该帖子的作者');
	                return;
	            }

	            // 获取反应数最多的表情
	            let maxReactions = 0;
	            threadStarter.reactions.cache.forEach(reaction => {
	                const count = reaction.count;
	                if (count > maxReactions) {
	                    maxReactions = count;
	                }
	            });

	            // 准备审核日志
	            const moderationChannel = await interaction.client.channels.fetch(currentGuildConfig.roleApplication.logThreadId);
	            const auditEmbed = {
	                color: maxReactions >= 5 ? 0x00ff00 : 0xff0000,
	                title: maxReactions >= 5 ? '✅ 创作者身份组申请通过' : '❌ 创作者身份组申请未通过',
	                fields: [
	                    {
	                        name: '申请者',
	                        value: `<@${interaction.user.id}>`,
	                        inline: true,
	                    },
	                    {
	                        name: '作品链接',
	                        value: threadLink,
	                        inline: true,
	                    },
	                    {
	                        name: '最高反应数',
	                        value: `${maxReactions}`,
	                        inline: true,
	                    },
	                    {
	                        name: '作品所在服务器',
	                        value: thread.guild.name,
	                        inline: true,
	                    },
	                ],
	                timestamp: new Date(),
	                footer: {
	                    text: '自动审核系统',
	                },
	            };

	            if (maxReactions >= 5) {
	                // 添加身份组
	                const member = await interaction.guild.members.fetch(interaction.user.id);
	                await member.roles.add(currentGuildConfig.roleApplication.creatorRoleId);
	                await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');

	                // 只有通过审核才发送日志
	                if (moderationChannel) {
	                    await moderationChannel.send({ embeds: [auditEmbed] });
	                }

	                logTime(`用户 ${interaction.user.tag} 获得了创作者身份组`);
	            }
				else {
	                await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
	            }
	        }, 3); // 用户指令优先级

	    }
		catch (error) {
	        logTime(`处理创作者身份组申请时出错: ${error}`, true);
	        await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
	    }
	},

	// 处罚系统模态框处理器将在这里添加
	// 'punishment_appeal_modal': async (interaction) => {...},
	// 'punishment_reason_modal': async (interaction) => {...},
};

/**
 * 统一的模态框交互处理函数
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export async function handleModal(interaction) {
	const handler = modalHandlers[interaction.customId];
	if (!handler) {
	    logTime(`未找到模态框处理器: ${interaction.customId}`, true);
	    return;
	}

	try {
	    await handler(interaction);
	}
	catch (error) {
	    logTime(`模态框处理出错 [${interaction.customId}]: ${error instanceof DiscordAPIError ? handleDiscordError(error) : error}`, true);
	    if (!interaction.replied && !interaction.deferred) {
	        await interaction.reply({
	            content: `❌ ${error instanceof DiscordAPIError ? handleDiscordError(error) : '处理请求时出现错误，请稍后重试。'}`,
	            flags: ['Ephemeral'],
	        });
	    }
	}
}