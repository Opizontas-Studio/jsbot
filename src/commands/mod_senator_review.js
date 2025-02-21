import { ChannelType, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

export default {
    cooldown: 5,
    data: new SlashCommandBuilder().setName('议员快速审核').setDescription('快速审核议员申请帖'),

    async execute(interaction, guildConfig) {
        try {
            // 检查用户权限
            if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
            }

            // 检查服务器是否启用身份组申请功能
            if (!guildConfig?.roleApplication?.enabled) {
                await interaction.editReply({
                    content: '❌ 此服务器未启用身份组申请功能',
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
            if (
                !guildConfig.roleApplication.senatorRoleForumId ||
                interaction.channel.parent.id !== guildConfig.roleApplication.senatorRoleForumId
            ) {
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

            if (daysSinceJoin < 45) {
                await interaction.editReply({
                    content: `❌ 申请者加入服务器时间不足45天（当前: ${daysSinceJoin}天）`,
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
                    if (!linkGuildConfig) {
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
                    {
                        name: '作品详情',
                        value:
                            linkResults.map(r => `[链接](${r.link}) - ${r.reactions}个反应 (${r.server})`).join('\n') ||
                            '无有效作品',
                    },
                )
                .setTimestamp();

            if (passed) {
                try {
                    // 读取身份组同步配置
                    const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                    const syncResults = [];

                    // 查找议员和创作者的同步组
                    const senatorSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '赛博议员');
                    const creatorSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '创作者');

                    // 遍历所有配置的服务器
                    const allGuilds = Array.from(interaction.client.guilds.cache.values());
                    for (const guild of allGuilds) {
                        try {
                            // 检查服务器是否在配置中
                            const guildConfig = interaction.client.guildManager.getGuildConfig(guild.id);
                            if (!guildConfig) continue;

                            // 获取目标服务器的成员
                            const targetMember = await guild.members.fetch(applicant.id).catch(() => null);
                            if (!targetMember) continue;

                            // 添加议员身份组
                            if (senatorSyncGroup?.roles[guild.id]) {
                                const senatorRoleId = senatorSyncGroup.roles[guild.id];
                                if (!targetMember.roles.cache.has(senatorRoleId)) {
                                    await targetMember.roles.add(senatorRoleId);
                                    syncResults.push(`在 ${guild.name} 添加议员身份组`);
                                }
                            }

                            // 添加创作者身份组（如果没有）
                            if (creatorSyncGroup?.roles[guild.id]) {
                                const creatorRoleId = creatorSyncGroup.roles[guild.id];
                                if (!targetMember.roles.cache.has(creatorRoleId)) {
                                    await targetMember.roles.add(creatorRoleId);
                                    syncResults.push(`在 ${guild.name} 添加创作者身份组`);
                                }
                            }
                        } catch (error) {
                            logTime(`在服务器 ${guild.name} 同步身份组失败: ${error.message}`, true);
                        }
                    }

                    // 添加同步结果到embed
                    if (syncResults.length > 0) {
                        embed.addFields({
                            name: '身份组同步结果',
                            value: syncResults.join('\n'),
                            inline: false,
                        });
                    }

                    logTime(`管理员 ${interaction.user.tag} 通过了 ${applicant.tag} 的议员申请，对 ${syncResults.length} 个身份组授权。`);
                } catch (error) {
                    logTime(`添加身份组失败: ${error.message}`, true);
                    throw error;
                }
            }

            // 在帖子中发送审核结果
            await interaction.channel.send({ embeds: [embed] });

            // 回复操作者
            await interaction.editReply({
                content: passed ? '✅ 审核通过，已授予议员身份组' : '❌ 审核未通过，反应数不足',
            });
        } catch (error) {
            await handleCommandError(interaction, error, '议员快速审核');
        }
    },
};
