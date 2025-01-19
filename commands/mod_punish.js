import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { handleCommandError, checkAndHandlePermission } from '../utils/helper.js';
import { calculatePunishmentDuration } from '../utils/punishment_helper.js';
import PunishmentService from '../services/punishment_service.js';
import { handleConfirmationButton } from '../handlers/buttons.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('处罚')
        .setDescription('对用户执行处罚')
        .addSubcommand(subcommand =>
            subcommand
                .setName('永封')
                .setDescription('永久封禁用户')
                .addUserOption(option =>
                    option.setName('用户')
                        .setDescription('要处罚的用户')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('原因')
                        .setDescription('处罚原因')
                        .setRequired(true)
                )
                .addBooleanOption(option =>
                    option.setName('保留消息')
                        .setDescription('是否保留用户的消息')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('禁言')
                .setDescription('临时禁言用户')
                .addUserOption(option =>
                    option.setName('用户')
                        .setDescription('要处罚的用户')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('时长')
                        .setDescription('禁言时长 (例如: 3d4h5m)')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('原因')
                        .setDescription('处罚原因')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('警告')
                        .setDescription('同时添加警告 (例如: 30d)')
                        .setRequired(false)
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!await checkAndHandlePermission(interaction, guildConfig.ModeratorRoleIds)) return;

        try {
            const subcommand = interaction.options.getSubcommand();
            const target = interaction.options.getUser('用户');
            const reason = interaction.options.getString('原因');

            // 检查目标用户是否为管理员
            const member = await interaction.guild.members.fetch(target.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.editReply({
                    content: '❌ 无法对管理员执行处罚',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 基础处罚数据
            const punishmentData = {
                userId: target.id,
                guildId: interaction.guildId,
                reason,
                executorId: interaction.user.id
            };

            if (subcommand === '永封') {
                const keepMessages = interaction.options.getBoolean('保留消息');
                
                // 添加确认窗口
                await handleConfirmationButton({
                    interaction,
                    customId: 'confirm_ban',
                    buttonLabel: '确认永封',
                    embed: {
                        color: 0xFF0000,
                        title: '⚠️ 永封确认',
                        description: [
                            `你确定要永久封禁用户 ${target.tag} 吗？`,
                            '',
                            '**处罚详情：**',
                            `- 用户：${target.tag} (${target.id})`,
                            `- 原因：${reason}`,
                            `- ${keepMessages ? '保留' : '删除'}用户消息`,
                            '',
                            '**⚠️ 警告：此操作不可撤销！**'
                        ].join('\n')
                    },
                    onConfirm: async (confirmation) => {
                        await confirmation.update({
                            content: '正在执行永封...',
                            embeds: [],
                            components: []
                        });

                        // 执行永封
                        await PunishmentService.executePunishment(interaction.client, {
                            ...punishmentData,
                            type: 'ban',
                            duration: -1,
                            keepMessages
                        }, guildConfig);

                        await confirmation.editReply({
                            content: `✅ 已永久封禁用户 ${target.tag}`,
                            flags: ['Ephemeral']
                        });
                    },
                    onError: async (error) => {
                        await handleCommandError(interaction, error, '永封');
                    }
                });

            } else if (subcommand === '禁言') {
                const muteTime = interaction.options.getString('时长');
                const warnTime = interaction.options.getString('警告');

                // 计算禁言时长
                const muteDuration = calculatePunishmentDuration(muteTime);
                if (muteDuration === -1) {
                    await interaction.editReply({
                        content: '❌ 无效的禁言时长格式',
                        flags: ['Ephemeral']
                    });
                    return;
                }

                // 执行禁言
                await PunishmentService.executePunishment(interaction.client, {
                    ...punishmentData,
                    type: 'mute',
                    duration: muteDuration
                }, guildConfig);

                // 如果有警告，同时创建警告记录
                if (warnTime) {
                    const warnDuration = calculatePunishmentDuration(warnTime);
                    if (warnDuration === -1) {
                        await interaction.editReply({
                            content: '⚠️ 禁言已执行，但警告时长格式无效',
                            flags: ['Ephemeral']
                        });
                        return;
                    }

                    // 检查是否配置了警告身份组
                    if (!guildConfig.WarnedRoleId) {
                        await interaction.editReply({
                            content: '⚠️ 禁言已执行，但未配置警告身份组，无法添加警告',
                            flags: ['Ephemeral']
                        });
                        return;
                    }

                    try {
                        // 添加警告身份组
                        const member = await interaction.guild.members.fetch(target.id);
                        await member.roles.add(guildConfig.WarnedRoleId);

                        // 创建警告记录，使用传入的警告时长
                        await PunishmentService.executePunishment(interaction.client, {
                            ...punishmentData,
                            type: 'warn',
                            duration: warnDuration, // 直接使用传入的警告时长
                            reason: `${reason} (禁言附加警告)`
                        }, guildConfig);

                        await interaction.editReply({
                            content: `✅ 已对 ${target.tag} 执行禁言处罚并添加警告`,
                            flags: ['Ephemeral']
                        });
                    } catch (error) {
                        await interaction.editReply({
                            content: `⚠️ 禁言已执行，但添加警告失败: ${error.message}`,
                            flags: ['Ephemeral']
                        });
                    }
                } else {
                    await interaction.editReply({
                        content: `✅ 已对 ${target.tag} 执行禁言处罚`,
                        flags: ['Ephemeral']
                    });
                }
            }

        } catch (error) {
            await handleCommandError(interaction, error, '处罚');
        }
    },
}; 