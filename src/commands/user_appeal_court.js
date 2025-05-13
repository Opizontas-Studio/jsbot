import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { handleConfirmationButton } from '../handlers/buttons.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { handleCommandError, validateImageFile } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { calculatePunishmentDuration, formatPunishmentDuration } from '../utils/punishmentHelper.js';

export default {
    cooldown: 120,
    data: new SlashCommandBuilder()
        .setName('申请上庭')
        .setDescription('向议事区提交处罚申请，交议事流程处理')
        .addSubcommand(subcommand =>
            subcommand
                .setName('禁言')
                .setDescription('申请禁言及弹劾处罚（可弹劾管理员，禁言最大14天）')
                .addUserOption(option => option.setName('目标').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option =>
                    option
                        .setName('禁言时间')
                        .setDescription('禁言时长 (最短2天，例如: 3d5h，即3天5小时)')
                        .setRequired(true),
                )
                .addStringOption(option =>
                    option
                        .setName('理由')
                        .setDescription('处罚理由（至多1000字，可以带有消息链接等）')
                        .setRequired(true),
                )
                .addStringOption(option =>
                    option
                        .setName('附加警告期')
                        .setDescription('附加警告时长 (最短15天，格式如: 30d，即30天)')
                        .setRequired(false),
                )
                .addAttachmentOption(option =>
                    option
                        .setName('证据图片')
                        .setDescription('相关证据的图片文件 (支持jpg、jpeg、png、gif或webp格式)')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('永封')
                .setDescription('申请永久封禁')
                .addUserOption(option => option.setName('目标').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('理由').setDescription('处罚理由').setRequired(true))
                .addBooleanOption(option =>
                    option.setName('保留消息').setDescription('是否保留用户的消息').setRequired(false),
                )
                .addAttachmentOption(option =>
                    option
                        .setName('证据图片')
                        .setDescription('相关证据的图片文件 (支持jpg、jpeg、png、gif或webp格式)')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('弹劾')
                .setDescription('申请弹劾管理员')
                .addUserOption(option => option.setName('目标').setDescription('要弹劾的管理员').setRequired(true))
                .addStringOption(option =>
                    option
                        .setName('理由')
                        .setDescription('弹劾理由（至多1000字，可以带有消息链接等）')
                        .setRequired(true),
                )
                .addAttachmentOption(option =>
                    option
                        .setName('证据图片')
                        .setDescription('相关证据的图片文件 (支持jpg、jpeg、png、gif或webp格式)')
                        .setRequired(false),
                ),
        ),

    async execute(interaction, guildConfig) {
        // 检查议事系统是否启用
        if (!guildConfig.courtSystem?.enabled) {
            await interaction.editReply({
                content: '❌ 此服务器未启用议事系统',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查用户是否正在参与辩诉
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(guildConfig.roleApplication?.appealDebateRoleId)) {
            await interaction.editReply({
                content: '❌ 你正在参与其他辩诉，无法提交新的申请',
                flags: ['Ephemeral'],
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === '禁言' || subcommand === '永封' || subcommand === '弹劾') {
                const target = interaction.options.getUser('目标');
                const reason = interaction.options.getString('理由');
                const imageAttachment = interaction.options.getAttachment('证据图片');

                // 在获取图片附件后立即验证
                if (imageAttachment) {
                    const { isValid, error } = validateImageFile(imageAttachment);
                    if (!isValid) {
                        await interaction.editReply({
                            content: `❌ ${error}`,
                            flags: ['Ephemeral'],
                        });
                        return;
                    }
                }

                if (subcommand === '禁言') {
                    const muteTime = interaction.options.getString('禁言时间');
                    const warningTime = interaction.options.getString('附加警告期');

                    // 验证时间格式
                    const muteDuration = calculatePunishmentDuration(muteTime);
                    if (muteDuration === -1) {
                        await interaction.editReply({
                            content: '❌ 无效的禁言时长格式',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查禁言时长是否至少2天
                    const minMuteDuration = 2 * 24 * 60 * 60 * 1000; // 2天的毫秒数
                    if (muteDuration < minMuteDuration) {
                        await interaction.editReply({
                            content: '❌ 禁言时长不能少于2天',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查禁言时长是否超过14天
                    const maxMuteDuration = 14 * 24 * 60 * 60 * 1000; // 14天的毫秒数
                    if (muteDuration > maxMuteDuration) {
                        await interaction.editReply({
                            content: '❌ 禁言时长不能超过14天',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 获取目标用户的GuildMember对象
                    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
                    if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
                        await interaction.editReply({
                            content: '❌ 无法对管理员执行处罚',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    let warningDuration = null;
                    if (warningTime) {
                        warningDuration = calculatePunishmentDuration(warningTime);
                        if (warningDuration === -1) {
                            await interaction.editReply({
                                content: '❌ 无效的警告时长格式',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }

                        // 检查警告期是否至少15天
                        const minWarningDuration = 15 * 24 * 60 * 60 * 1000; // 15天的毫秒数
                        if (warningDuration < minWarningDuration) {
                            await interaction.editReply({
                                content: '❌ 附加警告期不能少于15天',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }
                    }

                    // 创建确认消息
                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_court_mute',
                        buttonLabel: '确认提交',
                        embed: {
                            color: 0xff9900,
                            title: '禁言处罚申请',
                            description: [
                                `你确定要向议事区提交对 ${target.tag} 的处罚申请吗？`,
                                '',
                                '**处罚详情：**',
                                '- 类型：禁言',
                                `- 目标：${target.tag} (${target.id})`,
                                `- 时长：${formatPunishmentDuration(muteDuration)}`,
                                warningTime ? `- 附加警告期：${formatPunishmentDuration(warningDuration)}` : null,
                                `- 理由：${reason}`,
                                '',
                                '请慎重考虑占用公共资源。如需撤销请点击 撤回申请 按钮。',
                            ]
                                .filter(Boolean)
                                .join('\n'),
                            image: imageAttachment ? { url: imageAttachment.url } : undefined,
                        },
                        onConfirm: async confirmation => {
                            // 更新交互消息
                            await confirmation.deferUpdate();

                            // 获取议事区频道
                            const courtChannel = await interaction.guild.channels.fetch(
                                guildConfig.courtSystem.courtChannelId,
                            );

                            // 计算过期时间
                            const expireTime = new Date(Date.now() + guildConfig.courtSystem.appealDuration);

                            // 发送议事申请消息
                            const message = await courtChannel.send({
                                embeds: [
                                    {
                                        color: 0xff9900,
                                        title: '禁言处罚申请',
                                        description: `议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                                        fields: [
                                            {
                                                name: '处罚对象',
                                                value: `<@${target.id}>`,
                                                inline: true,
                                            },
                                            {
                                                name: '禁言时长',
                                                value: formatPunishmentDuration(muteDuration),
                                                inline: true,
                                            },
                                            warningTime
                                                ? {
                                                      name: '附加警告期',
                                                      value: formatPunishmentDuration(warningDuration),
                                                      inline: true,
                                                  }
                                                : null,
                                            {
                                                name: '处罚理由',
                                                value: reason,
                                                inline: false,
                                            },
                                        ].filter(Boolean),
                                        timestamp: new Date(),
                                        footer: {
                                            text: `申请人：${interaction.user.tag}`,
                                        },
                                        image: imageAttachment ? { url: imageAttachment.url } : undefined,
                                    },
                                ],
                                components: [
                                    {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 3,
                                                label: '支持',
                                                custom_id: `support_mute_${target.id}_${interaction.user.id}`,
                                                emoji: { name: '👍' },
                                            },
                                            {
                                                type: 2,
                                                style: 4,
                                                label: '撤回申请',
                                                custom_id: `revoke_process_${interaction.user.id}_court_mute`,
                                                emoji: { name: '↩️' },
                                            },
                                        ],
                                    },
                                ],
                            });

                            // 创建新的议事流程
                            const process = await ProcessModel.createCourtProcess({
                                type: 'court_mute',
                                targetId: target.id,
                                executorId: interaction.user.id,
                                messageId: message.id,
                                expireAt: expireTime.getTime(),
                                details: {
                                    embed: message.embeds[0].toJSON(),
                                    muteTime,
                                    warningTime,
                                    imageUrl: imageAttachment?.url,
                                },
                            });

                            // 更新消息以添加流程ID
                            await message.edit({
                                embeds: [
                                    {
                                        ...message.embeds[0].data,
                                        footer: {
                                            text: `申请人：${interaction.user.tag} | 流程ID: ${process.id}`,
                                        },
                                    },
                                ],
                            });

                            // 调度流程到期处理
                            if (process) {
                                await globalTaskScheduler
                                    .getProcessScheduler()
                                    .scheduleProcess(process, interaction.client);
                            }

                            // 发送通知到当前频道
                            await interaction.channel.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '议事申请已创建',
                                        description: [
                                            `<@${interaction.user.id}> 已创建对 <@${target.id}> 的禁言处罚申请`,
                                            '',
                                            '**申请详情：**',
                                            `- 禁言时长：${formatPunishmentDuration(muteDuration)}`,
                                            warningTime
                                                ? `- 附加警告期：${formatPunishmentDuration(warningDuration)}`
                                                : null,
                                            `- 处罚理由：${reason}`,
                                            '',
                                            `👉 [点击查看议事区](${courtChannel.url})`,
                                        ]
                                            .filter(Boolean)
                                            .join('\n'),
                                        timestamp: new Date(),
                                    },
                                ],
                            });

                            await interaction.editReply({
                                content: '✅ 处罚申请已提交到议事区',
                                components: [],
                                embeds: [],
                                flags: ['Ephemeral'],
                            });
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '禁言处罚申请操作已超时。如需继续请重新执行命令。',
                                    },
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '申请上庭');
                        },
                    });
                } else if (subcommand === '永封') {
                    const keepMessages = interaction.options.getBoolean('保留消息') ?? true;
                    const imageAttachment = interaction.options.getAttachment('证据图片');

                    // 检查目标用户是否为管理员
                    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
                    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
                        await interaction.editReply({
                            content: '❌ 无法对管理员执行处罚',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_court_ban',
                        buttonLabel: '确认提交',
                        embed: {
                            color: 0xff0000,
                            title: '⚖️ 议事区申请确认',
                            description: [
                                `你确定要向议事区提交对 ${target.tag} 的永封申请吗？`,
                                '',
                                '**处罚详情：**',
                                '- 类型：永久封禁',
                                `- 目标：${target.tag} (${target.id})`,
                                `- ${keepMessages ? '保留' : '删除'}用户消息`,
                                `- 理由：${reason}`,
                                '',
                                '请慎重考虑占用公共资源。如需撤销请点击 撤回申请 按钮。',
                            ].join('\n'),
                            image: imageAttachment ? { url: imageAttachment.url } : undefined,
                        },
                        onConfirm: async confirmation => {
                            // 更新交互消息
                            await confirmation.deferUpdate();

                            // 获取议事区频道
                            const courtChannel = await interaction.guild.channels.fetch(
                                guildConfig.courtSystem.courtChannelId,
                            );

                            // 计算过期时间
                            const expireTime = new Date(Date.now() + guildConfig.courtSystem.appealDuration);

                            // 发送议事申请消息
                            const message = await courtChannel.send({
                                embeds: [
                                    {
                                        color: 0xff0000,
                                        title: '永封处罚申请',
                                        description: `议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                                        fields: [
                                            {
                                                name: '处罚对象',
                                                value: `<@${target.id}>`,
                                                inline: true,
                                            },
                                            {
                                                name: '消息处理',
                                                value: keepMessages ? '保留消息' : '删除消息',
                                                inline: true,
                                            },
                                            {
                                                name: '处罚理由',
                                                value: reason,
                                                inline: false,
                                            },
                                        ],
                                        timestamp: new Date(),
                                        footer: {
                                            text: `申请人：${interaction.user.tag}`,
                                        },
                                        image: imageAttachment ? { url: imageAttachment.url } : undefined,
                                    },
                                ],
                                components: [
                                    {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 3,
                                                label: '支持',
                                                custom_id: `support_ban_${target.id}_${interaction.user.id}`,
                                                emoji: { name: '👍' },
                                            },
                                            {
                                                type: 2,
                                                style: 4,
                                                label: '撤回申请',
                                                custom_id: `revoke_process_${interaction.user.id}_court_ban`,
                                                emoji: { name: '↩️' },
                                            },
                                        ],
                                    },
                                ],
                            });

                            // 创建新的议事流程
                            const process = await ProcessModel.createCourtProcess({
                                type: 'court_ban',
                                targetId: target.id,
                                executorId: interaction.user.id,
                                messageId: message.id,
                                expireAt: expireTime.getTime(),
                                details: {
                                    embed: message.embeds[0].toJSON(),
                                    keepMessages,
                                    imageUrl: imageAttachment?.url,
                                },
                            });

                            // 更新消息以添加流程ID
                            await message.edit({
                                embeds: [
                                    {
                                        ...message.embeds[0].data,
                                        footer: {
                                            text: `申请人：${interaction.user.tag} | 流程ID: ${process.id}`,
                                        },
                                    },
                                ],
                            });

                            // 调度流程到期处理
                            if (process) {
                                await globalTaskScheduler
                                    .getProcessScheduler()
                                    .scheduleProcess(process, interaction.client);
                            }

                            // 发送通知到当前频道
                            await interaction.channel.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '议事申请已创建',
                                        description: [
                                            `<@${interaction.user.id}> 已创建对 <@${target.id}> 的永封处罚申请`,
                                            '',
                                            '**申请详情：**',
                                            `- 消息处理：${keepMessages ? '保留' : '删除'}用户消息`,
                                            `- 处罚理由：${reason}`,
                                            '',
                                            `👉 [点击查看议事区](${courtChannel.url})`,
                                        ].join('\n'),
                                        timestamp: new Date(),
                                    },
                                ],
                            });

                            await interaction.editReply({
                                content: '✅ 处罚申请已提交到议事区',
                                components: [],
                                embeds: [],
                                flags: ['Ephemeral'],
                            });
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '永封处罚申请操作已超时。如需继续请重新执行命令。',
                                    },
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '申请上庭');
                        },
                    });
                } else if (subcommand === '弹劾') {
                    const imageAttachment = interaction.options.getAttachment('证据图片');

                    // 读取身份组同步配置
                    try {
                        const fs = await import('fs');
                        const path = await import('path');
                        const roleSyncConfigPath = path.join(process.cwd(), 'data', 'roleSyncConfig.json');
                        const roleSyncConfig = JSON.parse(fs.readFileSync(roleSyncConfigPath, 'utf8'));

                        // 找到管理组和答疑组身份组
                        const adminGroup = roleSyncConfig.syncGroups.find(group => group.name === '管理组');
                        const qaGroup = roleSyncConfig.syncGroups.find(group => group.name === '答疑组');

                        if (!adminGroup) {
                            await interaction.editReply({
                                content: '❌ 无法找到管理组身份组配置',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }

                        // 检查目标用户是否有管理组或答疑组身份组
                        const adminRoleId = adminGroup.roles[interaction.guildId];
                        const qaRoleId = qaGroup.roles[interaction.guildId];

                        // 获取目标用户的GuildMember对象
                        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
                        const hasAdminRole = adminRoleId && targetMember.roles.cache.has(adminRoleId);
                        const hasQaRole = qaRoleId && targetMember.roles.cache.has(qaRoleId);

                        if (!hasAdminRole && !hasQaRole) {
                            await interaction.editReply({
                                content: '❌ 只能弹劾拥有管理组或答疑组身份组的用户',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }
                    } catch (error) {
                        logTime('加载身份组配置失败:', true);
                        await interaction.editReply({
                            content: '❌ 加载身份组配置失败',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_court_impeach',
                        buttonLabel: '确认提交',
                        embed: {
                            color: 0xff0000,
                            title: '⚖️ 议事区申请确认',
                            description: [
                                `你确定要向议事区提交对 ${target.tag} 的弹劾申请吗？`,
                                '',
                                '**弹劾详情：**',
                                '- 类型：弹劾管理员',
                                `- 目标：${target.tag} (${target.id})`,
                                `- 理由：${reason}`,
                                '',
                                '请慎重考虑占用公共资源。如需撤销请点击 撤回申请 按钮。',
                            ].join('\n'),
                            image: imageAttachment ? { url: imageAttachment.url } : undefined,
                        },
                        onConfirm: async confirmation => {
                            // 更新交互消息
                            await confirmation.deferUpdate();

                            // 获取议事区频道
                            const courtChannel = await interaction.guild.channels.fetch(
                                guildConfig.courtSystem.courtChannelId,
                            );

                            // 计算过期时间
                            const expireTime = new Date(Date.now() + guildConfig.courtSystem.appealDuration);

                            // 发送议事申请消息
                            const message = await courtChannel.send({
                                embeds: [
                                    {
                                        color: 0xff0000,
                                        title: '弹劾管理员申请',
                                        description: `议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                                        fields: [
                                            {
                                                name: '弹劾对象',
                                                value: `<@${target.id}>`,
                                                inline: true,
                                            },
                                            {
                                                name: '弹劾理由',
                                                value: reason,
                                                inline: false,
                                            },
                                        ],
                                        timestamp: new Date(),
                                        footer: {
                                            text: `申请人：${interaction.user.tag}`,
                                        },
                                        image: imageAttachment ? { url: imageAttachment.url } : undefined,
                                    },
                                ],
                                components: [
                                    {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 3,
                                                label: '支持',
                                                custom_id: `support_impeach_${target.id}_${interaction.user.id}`,
                                                emoji: { name: '👍' },
                                            },
                                            {
                                                type: 2,
                                                style: 4,
                                                label: '撤回申请',
                                                custom_id: `revoke_process_${interaction.user.id}_court_impeach`,
                                                emoji: { name: '↩️' },
                                            },
                                        ],
                                    },
                                ],
                            });

                            // 创建新的议事流程
                            const process = await ProcessModel.createCourtProcess({
                                type: 'court_impeach',
                                targetId: target.id,
                                executorId: interaction.user.id,
                                messageId: message.id,
                                expireAt: expireTime.getTime(),
                                details: {
                                    embed: message.embeds[0].toJSON(),
                                    reason,
                                    imageUrl: imageAttachment?.url,
                                },
                            });

                            // 更新消息以添加流程ID
                            await message.edit({
                                embeds: [
                                    {
                                        ...message.embeds[0].data,
                                        footer: {
                                            text: `申请人：${interaction.user.tag} | 流程ID: ${process.id}`,
                                        },
                                    },
                                ],
                            });

                            // 调度流程到期处理
                            if (process) {
                                await globalTaskScheduler
                                    .getProcessScheduler()
                                    .scheduleProcess(process, interaction.client);
                            }

                            // 发送通知到当前频道
                            await interaction.channel.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '议事申请已创建',
                                        description: [
                                            `<@${interaction.user.id}> 已创建对 <@${target.id}> 的弹劾管理员申请`,
                                            '',
                                            '**申请详情：**',
                                            `- 弹劾理由：${reason}`,
                                            '',
                                            `👉 [点击查看议事区](${courtChannel.url})`,
                                        ].join('\n'),
                                        timestamp: new Date(),
                                    },
                                ],
                            });

                            await interaction.editReply({
                                content: '✅ 处罚申请已提交到议事区',
                                components: [],
                                embeds: [],
                                flags: ['Ephemeral'],
                            });
                        },
                        onTimeout: async interaction => {
                            await interaction.editReply({
                                embeds: [
                                    {
                                        color: 0x808080,
                                        title: '❌ 确认已超时',
                                        description: '弹劾管理员申请操作已超时。如需继续请重新执行命令。',
                                    },
                                ],
                                components: [],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '申请上庭');
                        },
                    });
                }
            }
        } catch (error) {
            await handleCommandError(interaction, error, '申请上庭');
        }
    },
};
