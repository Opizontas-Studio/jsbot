import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { calculatePunishmentDuration, checkModeratorPermission, handleCommandError, validateWarningDuration } from '../../utils/helper.js';
import { sendPunishmentConfirmation } from '../../utils/punishmentConfirmationHelper.js';

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
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('警告')
                .setDescription('对用户执行警告处罚')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('时长').setDescription('警告时长 (例如: 30d)，最大90天').setRequired(true))
                .addStringOption(option => option.setName('原因').setDescription('处罚原因（手机使用此命令建议小于60个汉字，否则有截断BUG）').setRequired(true))
        ),

    async execute(interaction, guildConfig) {
        try {
            const subcommand = interaction.options.getSubcommand();
            const target = interaction.options.getUser('用户');
            const reason = interaction.options.getString('原因');

            // 统一权限检查
            if (subcommand === '永封') {
                // 永封需要管理员权限
                const hasAdminRole = interaction.member.roles.cache.some(role =>
                    guildConfig.AdministratorRoleIds.includes(role.id),
                );
                if (!hasAdminRole) {
                    await interaction.editReply({
                        content: '你没有权限执行永封操作。需要具有管理员身份组。',
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            } else if (subcommand === '禁言' || subcommand === '警告' || subcommand === '软封锁') {
                // 检查基本权限
                if (!(await checkModeratorPermission(interaction, guildConfig))) {
                    return;
                }
            }

            // 统一检查确认频道配置
            if (!guildConfig.punishmentConfirmationChannelId) {
                await interaction.editReply({
                    content: '❌ 服务器未配置处罚确认频道，无法执行处罚',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查目标用户是否为管理员
            try {
                const member = await interaction.guild.members.fetch(target.id);
                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

                if (isAdmin) {
                    await interaction.editReply({
                        content: '❌ DC无法对admin执行处罚',
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            } catch (error) {
                // 如果用户不在服务器中，则跳过管理员检查
                if (error.code !== 10007) { // 10007 是 Discord API 返回的"Unknown Member"错误码
                    throw error; // 如果是其他错误，则继续抛出
                }
            }

            if (subcommand === '永封') {
                const keepMessages = interaction.options.getBoolean('保留消息');

                const banData = {
                    type: 'ban',
                    userId: target.id,
                    reason,
                    duration: -1,
                    executorId: interaction.user.id,
                    keepMessages: keepMessages,
                    channelId: interaction.channelId,
                };

                // 发送确认请求
                await sendPunishmentConfirmation({
                    client: interaction.client,
                    channelId: guildConfig.punishmentConfirmationChannelId,
                    interaction,
                    punishmentData: banData,
                    punishmentType: 'ban',
                    target,
                    reason
                });
            } else if (subcommand === '软封锁') {
                const warnTime = interaction.options.getString('警告');

                // 验证警告时长
                const warningValidation = validateWarningDuration(warnTime);
                if (!warningValidation.isValid) {
                    await interaction.editReply({
                        content: `❌ ${warningValidation.error}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
                const warningDuration = warningValidation.duration;

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

                // 发送确认请求
                await sendPunishmentConfirmation({
                    client: interaction.client,
                    channelId: guildConfig.punishmentConfirmationChannelId,
                    interaction,
                    punishmentData: softbanData,
                    punishmentType: 'softban',
                    target,
                    reason
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

                // 验证警告时长
                const warningValidation = validateWarningDuration(warnTime);
                if (!warningValidation.isValid) {
                    await interaction.editReply({
                        content: `❌ ${warningValidation.error}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
                const warningDuration = warningValidation.duration;

                const muteData = {
                    type: 'mute',
                    userId: target.id,
                    reason,
                    duration: muteDuration,
                    executorId: interaction.user.id,
                    channelId: interaction.channelId,
                    warningDuration: warningDuration,
                };

                // 发送确认请求
                await sendPunishmentConfirmation({
                    client: interaction.client,
                    channelId: guildConfig.punishmentConfirmationChannelId,
                    interaction,
                    punishmentData: muteData,
                    punishmentType: 'mute',
                    target,
                    reason
                });
            } else if (subcommand === '警告') {
                const warnTime = interaction.options.getString('时长');

                // 验证警告时长（纯警告必须提供时长）
                const warningValidation = validateWarningDuration(warnTime);
                if (!warningValidation.isValid) {
                    await interaction.editReply({
                        content: `❌ ${warningValidation.error}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
                const warningDuration = warningValidation.duration;

                const warningData = {
                    type: 'warning',
                    userId: target.id,
                    reason,
                    duration: -1, // 纯警告不需要禁言时长
                    executorId: interaction.user.id,
                    channelId: interaction.channelId,
                    warningDuration: warningDuration,
                };

                // 发送确认请求
                await sendPunishmentConfirmation({
                    client: interaction.client,
                    channelId: guildConfig.punishmentConfirmationChannelId,
                    interaction,
                    punishmentData: warningData,
                    punishmentType: 'warning',
                    target,
                    reason
                });
            }
        } catch (error) {
            await handleCommandError(interaction, error, '处罚');
        }
    },
};
