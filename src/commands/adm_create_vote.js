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
        .setName('创建投票')
        .setDescription('【管理员】创建一个测试投票')
        .addStringOption(option =>
            option
                .setName('类型')
                .setDescription('投票类型')
                .setRequired(true)
                .addChoices(
                    { name: '禁言处罚', value: 'court_mute' },
                    { name: '永封处罚', value: 'court_ban' },
                    { name: '处罚上诉', value: 'appeal' },
                ),
        )
        .addUserOption(option => option.setName('目标').setDescription('处罚/上诉的目标用户').setRequired(true))
        .addIntegerOption(option =>
            option
                .setName('处罚时长')
                .setDescription('处罚持续时间（分钟，仅禁言时有效）')
                .setMinValue(1)
                .setMaxValue(10080) // 一周
                .setRequired(false),
        )
        .addBooleanOption(option =>
            option.setName('保留消息').setDescription('是否保留消息记录（仅永封时有效）').setRequired(false),
        )
        .addIntegerOption(option =>
            option
                .setName('警告时长')
                .setDescription('附加警告时长（分钟，仅禁言时有效）')
                .setMinValue(0)
                .setMaxValue(10080) // 一周
                .setRequired(false),
        ),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理员权限
            if (!interaction.member.roles.cache.some(role => guildConfig.AdministratorRoleIds.includes(role.id))) {
                return await interaction.editReply({
                    content: '❌ 只有管理员可以使用此命令',
                    flags: ['Ephemeral'],
                });
            }

            const type = interaction.options.getString('类型');
            const target = interaction.options.getUser('目标');
            const punishDuration = interaction.options.getInteger('处罚时长') ?? 60; // 默认60分钟
            const keepMessages = interaction.options.getBoolean('保留消息') ?? false;
            const warningDuration = interaction.options.getInteger('警告时长') ?? 0;

            // 根据类型设置诉求内容
            let redSide, blueSide;
            if (type === 'appeal') {
                redSide = `解除对 <@${target.id}> 的处罚`;
                blueSide = '维持原判';
            } else if (type.startsWith('court_')) {
                const punishType = type === 'court_ban' ? '永封' : '禁言';
                redSide = `对 <@${target.id}> 执行${punishType}`;
                blueSide = '驳回处罚申请';
            }

            // 先创建消息
            const now = Date.now();
            const message = await interaction.channel.send({
                embeds: [
                    {
                        color: 0x5865f2,
                        title: '📊 测试投票',
                        description: [
                            `议事截止：<t:${Math.floor((now + guildConfig.courtSystem.voteDuration) / 1000)}:R>`,
                            '',
                            '**红方诉求：**',
                            redSide,
                            '',
                            '**蓝方诉求：**',
                            blueSide,
                            '',
                            '🔴▬▬▬▬▬|▬▬▬▬▬🔵',
                            '',
                            '票数将在30秒后公开',
                            '',
                            '**处罚详情：**',
                            `• 目标用户：<@${target.id}>`,
                            `• 处罚类型：${type === 'court_ban' ? '永封' : '禁言'}`,
                            type === 'court_ban' ? `• 处罚时长：永久` : `• 处罚时长：${punishDuration}分钟`,
                            warningDuration ? `• 警告时长：${warningDuration}分钟` : null,
                            type === 'court_ban' ? `• 保留消息：${keepMessages ? '是' : '否'}` : null,
                        ]
                            .filter(Boolean)
                            .join('\n'),
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
                                label: '支持红方',
                                custom_id: `vote_red_pending`, // 临时ID
                                emoji: '🔴',
                            },
                            {
                                type: 2,
                                style: 1,
                                label: '支持蓝方',
                                custom_id: `vote_blue_pending`, // 临时ID
                                emoji: '🔵',
                            },
                        ],
                    },
                ],
            });

            // 然后创建议事流程，直接使用实际的messageId
            const process = await ProcessModel.createCourtProcess({
                type,
                targetId: target.id,
                executorId: interaction.user.id,
                messageId: message.id,
                expireAt: now + guildConfig.courtSystem.voteDuration,
                details: {
                    reason: '测试投票',
                    duration: type === 'court_ban' ? -1 : punishDuration * 60 * 1000, // 永封为-1
                    warningDuration: warningDuration * 60 * 1000,
                    keepMessages,
                },
            });

            logTime(
                `创建投票 [ID: ${process.id}] - 类型: ${type}, 目标: ${target.tag}, 发起人: ${interaction.user.tag}`,
            );
            logTime(`投票详情 [ID: ${process.id}] - 红方: ${redSide}, 蓝方: ${blueSide}`);
            logTime(
                `投票时间 [ID: ${process.id}] - 公开: ${guildConfig.courtSystem.votePublicDelay / 1000}秒后, 结束: ${
                    guildConfig.courtSystem.voteDuration / 1000
                }秒后`,
            );

            // 创建投票
            const vote = await VoteService.createVoteForProcess(
                process,
                guildConfig,
                {
                    messageId: message.id,
                    threadId: interaction.channel.id,
                },
                interaction.client,
            );

            // 立即调度投票状态更新
            await globalTaskScheduler
                .getVoteScheduler()
                .scheduleVote(await VoteModel.getVoteById(vote.id), interaction.client);

            // 更新消息组件，使用正确的processId
            await message.edit({
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 4,
                                label: '支持红方',
                                custom_id: `vote_red_${process.id}`,
                                emoji: '🔴',
                            },
                            {
                                type: 2,
                                style: 1,
                                label: '支持蓝方',
                                custom_id: `vote_blue_${process.id}`,
                                emoji: '🔵',
                            },
                        ],
                    },
                ],
            });

            // 回复确认消息
            await interaction.editReply({
                content: '✅ 测试投票已创建',
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '创建投票');
        }
    },
};
