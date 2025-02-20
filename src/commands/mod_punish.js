import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { handleConfirmationButton } from '../handlers/buttons.js';
import PunishmentService from '../services/punishmentService.js';
import { checkAndHandlePermission, checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { calculatePunishmentDuration } from '../utils/punishmentHelper.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('处罚')
        .setDescription('对用户执行处罚')
        .addSubcommand(subcommand =>
            subcommand
                .setName('永封')
                .setDescription('永久封禁用户')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('原因').setDescription('处罚原因').setRequired(true))
                .addBooleanOption(option =>
                    option.setName('保留消息').setDescription('是否保留用户的消息').setRequired(true),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('禁言')
                .setDescription('临时禁言用户')
                .addUserOption(option => option.setName('用户').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option =>
                    option.setName('时长').setDescription('禁言时长 (例如: 3d4h5m)').setRequired(true),
                )
                .addStringOption(option => option.setName('原因').setDescription('处罚原因').setRequired(true))
                .addStringOption(option =>
                    option.setName('警告').setDescription('同时添加警告 (例如: 30d)').setRequired(false),
                ),
        ),

    async execute(interaction, guildConfig) {
        try {
            const subcommand = interaction.options.getSubcommand();
            const target = interaction.options.getUser('用户');
            const reason = interaction.options.getString('原因');

            // 根据子命令检查不同的权限
            if (subcommand === '永封') {
                // 永封需要管理员权限
                if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                    return;
                }
            } else if (subcommand === '禁言') {
                // 禁言需要版主或管理员权限
                if (!(await checkModeratorPermission(interaction, guildConfig))) {
                    return;
                }
            }

            // 检查目标用户是否为管理员
            const member = await interaction.guild.members.fetch(target.id);
            const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || 
                          member.roles.cache.some(role => guildConfig.AdministratorRoleIds.includes(role.id));
            
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

                        const result = await PunishmentService.executePunishment(interaction.client, banData);
                        await interaction.editReply({
                            content: result.message,
                            flags: ['Ephemeral'],
                        });
                    },
                    onError: async error => {
                        await handleCommandError(interaction, error, '永封');
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

                const muteData = {
                    type: 'mute',
                    userId: target.id,
                    reason,
                    duration: muteDuration,
                    executorId: interaction.user.id,
                    channelId: interaction.channelId,
                    warningDuration: warnTime ? calculatePunishmentDuration(warnTime) : null,
                };

                // 显示处理中消息
                await interaction.editReply({
                    content: '⏳ 正在执行禁言...',
                    flags: ['Ephemeral'],
                });

                // 执行处罚
                const result = await PunishmentService.executePunishment(interaction.client, muteData);

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
