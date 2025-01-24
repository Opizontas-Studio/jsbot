import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/process.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('提交议事')
        .setDescription('将当前帖子提交到议事区进行投票准备'),

    async execute(interaction, guildConfig) {
        try {
            // 检查是否在论坛帖子中使用
            if (!interaction.channel?.isThread() ||
                interaction.channel.parent?.type !== ChannelType.GuildForum) {
                await interaction.editReply({
                    content: '❌ 此命令只能在论坛帖子中使用',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查议事系统是否启用
            if (!guildConfig.courtSystem?.enabled) {
                await interaction.editReply({
                    content: '❌ 此服务器未启用议事系统',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取帖子信息
            const thread = interaction.channel;
            const starterMessage = await thread.fetchStarterMessage();

            if (!starterMessage) {
                await interaction.editReply({
                    content: '❌ 无法获取帖子首楼信息',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取议事区频道
            const courtChannel = await interaction.guild.channels.fetch(guildConfig.courtSystem.courtChannelId);
            if (!courtChannel) {
                await interaction.editReply({
                    content: '❌ 无法获取议事频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 计算过期时间
            const expireTime = new Date(Date.now() + guildConfig.courtSystem.summitDuration);

            // 发送议事消息
            const message = await courtChannel.send({
                embeds: [{
                    color: 0x5865F2,
                    title: thread.name,
                    description: `原帖：${starterMessage.url}\n\n议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                    fields: [
                        {
                            name: '创建人',
                            value: `<@${starterMessage.author.id}>`,
                            inline: true,
                        },
                        {
                            name: '提交人',
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        },
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: `需 ${guildConfig.courtSystem.requiredSupports} 个支持，再次点击可撤销支持`,
                    },
                }],
                components: [{
                    type: 1,
                    components: [{
                        type: 2,
                        style: 3,
                        label: '支持',
                        custom_id: `support_vote_${starterMessage.author.id}_${interaction.user.id}`,
                        emoji: '👍',
                    }],
                }],
            });

            // 在原帖子中发送议事状态消息
            const statusMessage = await thread.send({
                embeds: [{
                    color: 0x5865F2,
                    title: '📢 议事投票进行中',
                    description: [
                        '此帖已被提交到议事区征集意见。',
                        '',
                        '**议事详情：**',
                        `- 提交人：<@${interaction.user.id}>`,
                        `- 截止时间：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                        `- 议事消息：[点击查看](${message.url})`,
                        '',
                        '当前状态：等待议员支持',
                    ].join('\n'),
                    timestamp: new Date(),
                    footer: {
                        text: '需要达到指定数量的议员支持后才能进行投票',
                    },
                }],
            });

            // 创建议事流程
            const process = await ProcessModel.createCourtProcess({
                type: 'vote',
                targetId: starterMessage.author.id,
                executorId: interaction.user.id,
                messageId: message.id,
                statusMessageId: statusMessage.id,
                expireAt: expireTime.getTime(),
                details: {
                    embed: message.embeds[0].toJSON(),
                    threadId: thread.id,
                    threadUrl: thread.url,
                    starterMessageId: starterMessage.id,
                },
            });

            // 调度流程到期处理
            if (process) {
                await globalTaskScheduler.scheduleProcess(process, interaction.client);
            }

            // 发送确认消息
            await interaction.editReply({
                content: `✅ 已将帖子提交到议事区进行投票\n👉 [点击查看议事消息](${message.url})`,
                flags: ['Ephemeral'],
            });

            logTime(`用户 ${interaction.user.tag} 提交了帖子 ${thread.name} 到议事区`);

        } catch (error) {
            await handleCommandError(interaction, error, '提交议事');
        }
    },
};