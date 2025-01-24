import { ChannelType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
	    .setName('议员快速审核')
	    .setDescription('快速审核议员申请帖')
	    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction, guildConfig) {
	    try {
	        // 检查服务器是否启用身份组申请功能
	        if (!guildConfig?.roleApplication?.enabled) {
	            await interaction.editReply({
	                content: '❌ 此服务器未启用身份组申请功能',
	            });
	            return;
	        }

	        // 检查用户是否有管理身份组的权限
	        const channel = interaction.channel;
	        const memberPermissions = channel.permissionsFor(interaction.member);

	        if (!memberPermissions.has(PermissionFlagsBits.ManageRoles)) {
	            await interaction.editReply({
	                content: '你没有权限执行此命令。需要具有管理身份组的权限。',
	            });
	            return;
	        }

	        // 验证当前频道是否为论坛帖子
	        if (!interaction.channel.isThread()) {
	            await interaction.editReply({
	                content: '❌ 此命令只能在论坛帖子中使用',
	            });
	            return;
	        }

	        // 检查父频道是否为论坛
	        const parentChannel = interaction.channel.parent;
	        if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
	            await interaction.editReply({
	                content: '❌ 此子区不属于论坛频道',
	            });
	            return;
	        }

	        // 检查是否在指定的议员申请论坛中
	        if (!guildConfig.roleApplication.senatorRoleForumId ||
	            interaction.channel.parent.id !== guildConfig.roleApplication.senatorRoleForumId) {
	            await interaction.editReply({
	                content: '❌ 此命令只能在议员申请论坛中使用',
	            });
	            return;
	        }

	        // 检查是否配置了议员身份组
	        if (!guildConfig?.roleApplication?.senatorRoleId) {
	            await interaction.editReply({
	                content: '❌ 服务器未配置议员身份组',
	            });
	            return;
	        }

	        // 获取帖子首条消息
	        const firstMessage = (await interaction.channel.messages.fetch({ limit: 1, after: '0' })).first();
	        if (!firstMessage) {
	            await interaction.editReply({ content: '❌ 无法获取帖子首条消息' });
	            return;
	        }

	        // 检查申请者是否是帖子作者
	        const applicant = firstMessage.author;

	        // 检查申请者是否已有议员身份组
	        const member = await interaction.guild.members.fetch(applicant.id);
	        if (member.roles.cache.has(guildConfig.roleApplication.senatorRoleId)) {
	            await interaction.editReply({
	                content: '❌ 申请者已经拥有议员身份组',
	            });
	            return;
	        }

	        // 检查申请者加入时间
	        const joinedAt = member.joinedAt;
	        const daysSinceJoin = Math.floor((Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24));

	        if (daysSinceJoin < 15) {
	            await interaction.editReply({
	                content: `❌ 申请者加入服务器时间不足15天（当前: ${daysSinceJoin}天）`,
	            });
	            return;
	        }

	        // 提取消息中的链接
	        const linkPattern = /https:\/\/discord\.com\/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/g;
	        const content = firstMessage.content;
	        const links = [];
	        let match;

	        while ((match = linkPattern.exec(content)) !== null && links.length < 4) {
	            links.push({
	                guildId: match[1],
	                threadId: match[2],
	            });
	        }

	        if (links.length === 0) {
	            await interaction.editReply({ content: '❌ 未在首楼找到任何作品链接' });
	            return;
	        }

	        // 检查并统计每个链接的反应
	        let totalReactions = 0;
	        const linkResults = [];

	        for (const link of links) {
	            try {
	                // 检查链接所属服务器是否在配置中
	                const linkGuildConfig = interaction.client.guildManager.getGuildConfig(link.guildId);
	                if (!linkGuildConfig?.roleApplication?.enabled) {
                        continue;
                    }

	                const thread = await interaction.client.channels.fetch(link.threadId);
	                if (!thread || !thread.isThread()) {
                        continue;
                    }

	                const threadFirstMessage = (await thread.messages.fetch({ limit: 1, after: '0' })).first();
	                if (!threadFirstMessage || threadFirstMessage.author.id !== applicant.id) {
                        continue;
                    }

	                // 获取最大反应数
	                let maxReactions = 0;
	                threadFirstMessage.reactions.cache.forEach(reaction => {
	                    const count = reaction.count;
	                    if (count > maxReactions) {
	                        maxReactions = count;
	                    }
	                });

	                totalReactions += maxReactions;
	                linkResults.push({
	                    link: `https://discord.com/channels/${link.guildId}/${link.threadId}`,
	                    reactions: maxReactions,
	                    server: thread.guild.name,
	                });
	            } catch (error) {
	                console.error('处理链接时出错:', error);
	            }
	        }

	        // 创建审核结果嵌入消息
	        const passed = totalReactions >= 50; // 议员需要50个反应
	        const embed = new EmbedBuilder()
	            .setColor(passed ? 0x00ff00 : 0xff0000)
	            .setTitle(passed ? '✅ 议员身份组申请通过' : '❌ 议员身份组申请未通过')
	            .addFields(
	                { name: '申请者', value: `<@${applicant.id}>`, inline: true },
	                { name: '总反应数', value: `${totalReactions}/50`, inline: true },
	                { name: '加入天数', value: `${daysSinceJoin}天`, inline: true },
	                { name: '审核者', value: `<@${interaction.user.id}>`, inline: true },
	                { name: '作品详情', value: linkResults.map(r =>
	                    `[链接](${r.link}) - ${r.reactions}个反应 (${r.server})`,
	                ).join('\n') || '无有效作品' },
	            )
	            .setTimestamp();

	        if (passed) {
	            try {
	                // 添加议员身份组
	                await member.roles.add(guildConfig.roleApplication.senatorRoleId);

	                // 如果没有创作者身份组，也一并添加
	                if (!member.roles.cache.has(guildConfig.roleApplication.creatorRoleId)) {
	                    await member.roles.add(guildConfig.roleApplication.creatorRoleId);
	                    embed.addFields({
	                        name: '附加操作',
	                        value: '已同时授予创作者身份组',
	                        inline: false,
	                    });
	                }

	                logTime(`管理员 ${interaction.user.tag} 通过了用户 ${applicant.tag} 的议员申请`);
	            } catch (error) {
	                logTime(`添加身份组失败: ${error.message}`, true);
	                throw error;
	            }
	        }

	        // 在帖子中发送审核结果
	        await interaction.channel.send({ embeds: [embed] });

	        // 回复操作者
	        await interaction.editReply({
	            content: passed ?
	                '✅ 审核通过，已授予议员身份组' :
	                '❌ 审核未通过，反应数不足',
	        });

	    } catch (error) {
	        await handleCommandError(interaction, error, '议员快速审核');
	    }
    },
};