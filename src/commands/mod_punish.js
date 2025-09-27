import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import PunishmentService from '../services/punishmentService.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { calculatePunishmentDuration, checkAndHandlePermission, formatPunishmentDuration, handleCommandError } from '../utils/helper.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('处罚')
        .setDescription('对用户执行处罚')
        .addSubcommand(subcommand =>
            subcommand
                .setName('永封')
                .setDescription('永久封禁用户')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('原因').setDescription('处罚原因（手机使用此命令建议小于60个汉字，否则有截断BUG）').setRequired(true))
                .addBooleanOption(option =>
                    option.setName('保留消息').setDescription('是否保留用户的消息').setRequired(true),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('软封锁')
                .setDescription('软封锁用户（清理消息后立即解封，用户可重新加入）')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('原因').setDescription('处罚原因（手机使用此命令建议小于60个汉字，否则有截断BUG）').setRequired(true))
                .addStringOption(option =>
                    option.setName('警告').setDescription('同时添加警告 (例如: 30d)').setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('禁言')
                .setDescription('临时禁言用户')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option =>
                    option.setName('时长').setDescription('禁言时长 (例如: 3d4h5m)，最大14天').setRequired(true),
                )
                .addStringOption(option => option.setName('原因').setDescription('处罚原因（手机使用此命令建议小于60个汉字，否则有截断BUG）').setRequired(true))
                .addStringOption(option =>
                    option.setName('警告').setDescription('同时添加警告 (例如: 30d)').setRequired(false),
                ),
        ),

    async execute(interaction, guildConfig) {
        try {
            const subcommand = interaction.options.getSubcommand();
            const target = interaction.options.getUser('用户');
            const reason = interaction.options.getString('原因');

            // 声明权限相关变量
            let isQAerOnly = false;

            // 根据子命令检查不同的权限
            if (subcommand === '永封' || subcommand === '软封锁') {
                // 永封和软封锁需要管理员权限
                if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                    return;
                }
            } else if (subcommand === '禁言') {
                // 检查基本权限（管理员、版主或QAer）
                const hasAdminRole = interaction.member.roles.cache.some(role =>
                    guildConfig.AdministratorRoleIds.includes(role.id),
                );
                const hasModRole = interaction.member.roles.cache.some(role =>
                    guildConfig.ModeratorRoleIds.includes(role.id),
                );
                const hasQAerRole = interaction.member.roles.cache.some(role =>
                    role.id === guildConfig.roleApplication?.QAerRoleId,
                );

                if (!hasAdminRole && !hasModRole && !hasQAerRole) {
                    await interaction.editReply({
                        content: '你没有权限执行此操作。需要具有管理员、版主或答疑员身份组。',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 对于仅有QAer权限的用户，需要进行额外检查
                isQAerOnly = !hasAdminRole && !hasModRole && hasQAerRole;
            }

            // 检查目标用户是否为管理员
            let isAdmin = false;
            try {
                const member = await interaction.guild.members.fetch(target.id);
                isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
                         member.roles.cache.some(role => guildConfig.AdministratorRoleIds.includes(role.id));
            } catch (error) {
                // 如果用户不在服务器中，则跳过管理员检查
                if (error.code !== 10007) { // 10007 是 Discord API 返回的"Unknown Member"错误码
                    throw error; // 如果是其他错误，则继续抛出
                }
            }

            if (isAdmin) {
                await interaction.editReply({
                    content: '❌ 无法对管理员执行处罚',
                    flags: ['Ephemeral'],
                });
                return;
            }

            if (subcommand === '永封') {
                const keepMessages = interaction.options.getBoolean('保留消息');

                await handleConfirmationButton({
                    interaction,
                    customId: 'confirm_ban',
                    buttonLabel: '确认永封',
                    embed: {
                        color: 0xff0000,
                        title: '⚠️ 永封确认',
                        description: [
                            `你确定要永久封禁用户 ${target.tag} 吗？`,
                            '',
                            '**处罚详情：**',
                            `- 用户：${target.tag} (${target.id})`,
                            `- 原因：${reason}`,
                            `- ${keepMessages ? '保留' : '删除'}用户消息`,
                            '',
                            '**⚠️ 警告：此操作不可撤销！**',
                        ].join('\n'),
                    },
                    onConfirm: async confirmation => {
                        // 先更新交互消息
                        await confirmation.deferUpdate();
                        await interaction.editReply({
                            content: '⏳ 正在执行永封...',
                            components: [],
                            embeds: [],
                        });

                        const banData = {
                            type: 'ban',
                            userId: target.id,
                            reason,
                            duration: -1,
                            executorId: interaction.user.id,
                            keepMessages: keepMessages,
                            channelId: interaction.channelId,
                        };

                        const result = await PunishmentService.executePunishment(
                            interaction.client,
                            banData,
                            interaction.guildId
                        );
                        await interaction.editReply({
                            content: result.message,
                            flags: ['Ephemeral'],
                        });
                    },
                    onError: async error => {
                        await handleCommandError(interaction, error, '永封');
                    },
                });
            } else if (subcommand === '软封锁') {
                const warnTime = interaction.options.getString('警告');

                // 如果提供了警告时长，验证格式和时长
                let warningDuration = null;
                if (warnTime) {
                    warningDuration = calculatePunishmentDuration(warnTime);
                    if (warningDuration === -1) {
                        await interaction.editReply({
                            content: '❌ 无效的警告时长格式',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查警告时长是否超过90天
                    const MAX_WARNING_TIME = 90 * 24 * 60 * 60 * 1000;
                    if (warningDuration > MAX_WARNING_TIME) {
                        await interaction.editReply({
                            content: '❌ 警告时长不能超过90天',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }
                }

                await handleConfirmationButton({
                    interaction,
                    customId: 'confirm_softban',
                    buttonLabel: '确认软封锁',
                    embed: {
                        color: 0xff9900,
                        title: '⚠️ 软封锁确认',
                        description: [
                            `你确定要对用户 ${target.tag} 执行软封锁吗？`,
                            '',
                            '**处罚详情：**',
                            `- 用户：${target.tag} (${target.id})`,
                            `- 原因：${reason}`,
                            warningDuration ? `- 警告时长：${formatPunishmentDuration(warningDuration)}` : '- 警告时长：无',
                            '',
                            '**软封锁说明：**',
                            '- 用户将被临时封禁并清理消息',
                            '- 立即解除封禁，用户可重新加入服务器',
                            '- 用户将收到包含邀请链接的私信通知',
                            warningDuration ? '- 用户将在再次加入时获得警告身份组' : '',
                        ].filter(Boolean).join('\n'),
                    },
                    onConfirm: async confirmation => {
                        // 先更新交互消息
                        await confirmation.deferUpdate();
                        await interaction.editReply({
                            content: '⏳ 正在执行软封锁...',
                            components: [],
                            embeds: [],
                        });

                        const softbanData = {
                            type: 'softban',
                            userId: target.id,
                            reason,
                            duration: -1,
                            executorId: interaction.user.id,
                            keepMessages: false, // 软封锁总是删除消息
                            channelId: interaction.channelId,
                            warningDuration: warningDuration,
                        };

                        const result = await PunishmentService.executePunishment(
                            interaction.client,
                            softbanData,
                            interaction.guildId
                        );
                        await interaction.editReply({
                            content: result.message,
                            flags: ['Ephemeral'],
                        });
                    },
                    onError: async error => {
                        await handleCommandError(interaction, error, '软封锁');
                    },
                });
            } else if (subcommand === '禁言') {
                const muteTime = interaction.options.getString('时长');
                const warnTime = interaction.options.getString('警告');

                // 计算禁言时长
                const muteDuration = calculatePunishmentDuration(muteTime);
                if (muteDuration === -1) {
                    await interaction.editReply({
                        content: '❌ 无效的禁言时长格式',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 检查禁言时长是否超过14天
                const TIME_IN_MS = 14 * 24 * 60 * 60 * 1000;
                if (muteDuration > TIME_IN_MS) {
                    await interaction.editReply({
                        content: '❌ 禁言时长不能超过14天',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 对于QAer身份组，限制禁言时长不能超过1天
                if (isQAerOnly) {
                    const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
                    if (muteDuration > ONE_DAY_IN_MS) {
                        await interaction.editReply({
                            content: '❌ 答疑员身份组只能执行1天及以内的禁言',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }
                }

                // 如果提供了警告时长，验证格式和时长
                let warningDuration = null;
                if (warnTime) {
                    warningDuration = calculatePunishmentDuration(warnTime);
                    if (warningDuration === -1) {
                        await interaction.editReply({
                            content: '❌ 无效的警告时长格式',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查警告时长是否超过90天
                    const MAX_WARNING_TIME = 90 * 24 * 60 * 60 * 1000;
                    if (warningDuration > MAX_WARNING_TIME) {
                        await interaction.editReply({
                            content: '❌ 警告时长不能超过90天',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }
                }

                const muteData = {
                    type: 'mute',
                    userId: target.id,
                    reason,
                    duration: muteDuration,
                    executorId: interaction.user.id,
                    channelId: interaction.channelId,
                    warningDuration: warningDuration,
                };

                // 显示处理中消息
                await interaction.editReply({
                    content: '⏳ 正在执行禁言...',
                    flags: ['Ephemeral'],
                });

                // 执行处罚
                const result = await PunishmentService.executePunishment(
                    interaction.client,
                    muteData,
                    interaction.guildId
                );

                // 更新最终结果
                await interaction.editReply({
                    content: result.message,
                    flags: ['Ephemeral'],
                });
            }
        } catch (error) {
            await handleCommandError(interaction, error, '处罚');
        }
    },
};
