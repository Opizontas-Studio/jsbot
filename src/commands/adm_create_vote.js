import { SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { VoteService } from '../services/voteService.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('快速禁言')
        .setDescription('创建一个持续5分钟的快速禁言1小时投票（测试命令）')
        .addUserOption(option => option.setName('目标').setDescription('处罚的目标用户').setRequired(true)),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理员权限
            if (!interaction.member.roles.cache.some(role => guildConfig.AdministratorRoleIds.includes(role.id))) {
                return await interaction.editReply({
                    content: '❌ 只有管理员可以使用此命令',
                    flags: ['Ephemeral'],
                });
            }

            const target = interaction.options.getUser('目标');
            const muteDuration = '1h'; // 固定时长

            // 创建投票消息
            const now = Date.now();
            // 使用快速投票的时间配置
            const quickVoteConfig = guildConfig.courtSystem.quickVote;
            const message = await interaction.channel.send({
                embeds: [
                    {
                        color: 0x5865f2,
                        title: '📊 快速禁言投票',
                        description: [
                            `投票截止：<t:${Math.floor((now + quickVoteConfig.duration) / 1000)}:R>`,
                            '',
                            '**诉求：**',
                            `对 <@${target.id}> 执行禁言`,
                            '',
                            '🔴▬▬▬▬▬|▬▬▬▬▬🔵',
                            '',
                            '**处罚详情：**',
                            `• 目标用户：<@${target.id}>`,
                            `• 处罚时长：${muteDuration}`,
                        ].join('\n'),
                        footer: {
                            text: `发起人：${interaction.user.tag}`,
                        },
                        timestamp: new Date(),
                    },
                ],
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 4,
                                label: '支持',
                                custom_id: `vote_red_pending`,
                            },
                            {
                                type: 2,
                                style: 1,
                                label: '支持',
                                custom_id: `vote_blue_pending`,
                            },
                        ],
                    },
                ],
            });

            // 创建议事流程
            const process = await ProcessModel.createCourtProcess({
                type: 'court_mute',
                targetId: target.id,
                executorId: interaction.user.id,
                messageId: message.id,
                status: 'completed', // 直接标记为完成
                expireAt: now + quickVoteConfig.duration,
                details: {
                    reason: '快速禁言投票',
                    muteTime: muteDuration,
                },
            });

            // 创建投票时传入快速投票配置
            const vote = await VoteService.createVoteForProcess(
                process,
                {
                    ...guildConfig,
                    courtSystem: {
                        ...guildConfig.courtSystem,
                        votePublicDelay: quickVoteConfig.publicDelay,
                        voteDuration: quickVoteConfig.duration,
                    },
                },
                {
                    messageId: message.id,
                    threadId: interaction.channel.id,
                },
                interaction.client,
            );

            // 记录日志
            logTime(
                `创建投票 [ID: ${vote.id}] - 类型: court_mute, 目标: ${target.tag}, 发起人: ${interaction.user.tag}`,
            );
            logTime(`投票详情 [ID: ${vote.id}] - 红方: 对 <@${target.id}> 执行禁言, 蓝方: 驳回处罚申请`);
            logTime(
                `投票时间 [ID: ${vote.id}] - 公开: ${guildConfig.courtSystem.votePublicDelay / 1000}秒后, 结束: ${
                    guildConfig.courtSystem.voteDuration / 1000
                }秒后`,
            );

            // 调度投票状态更新
            await globalTaskScheduler
                .getVoteScheduler()
                .scheduleVote(await VoteModel.getVoteById(vote.id), interaction.client);

            // 更新投票按钮
            await message.edit({
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 4,
                                label: '支持',
                                custom_id: `vote_red_${vote.id}`,
                            },
                            {
                                type: 2,
                                style: 1,
                                label: '支持',
                                custom_id: `vote_blue_${vote.id}`,
                            },
                        ],
                    },
                ],
            });

            // 回复确认消息
            await interaction.editReply({
                content: '✅ 快速禁言投票已创建',
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '创建投票');
        }
    },
};
