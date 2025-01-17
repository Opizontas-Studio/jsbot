import { SlashCommandBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from 'discord.js';
import { handleCommandError, checkPermission, handlePermissionResult, sendModerationLog } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('暂停邀请')
        .setDescription('管理服务器的邀请功能')
        .addStringOption(option =>
            option.setName('操作')
                .setDescription('选择开启或关闭邀请功能')
                .setRequired(true)
                .addChoices(
                    { name: '闭关锁国', value: 'enable' },
                    { name: '开闸放水', value: 'disable' }
                ))
        .addStringOption(option =>
            option.setName('理由')
                .setDescription('执行此操作的原因')
                .setRequired(true)),

    async execute(interaction, guildConfig) {
        // 检查权限
        const hasPermission = checkPermission(interaction.member, guildConfig.AdministratorRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        await interaction.deferReply({ flags: ['Ephemeral'] });
        const action = interaction.options.getString('操作');
        const reason = interaction.options.getString('理由');
        const guild = interaction.guild;

        // 检查机器人权限
        if (!guild.members.me.permissions.has('ManageGuild')) {
            await interaction.editReply({
                content: '❌ 机器人缺少管理服务器权限，无法设置邀请暂停',
            });
            return;
        }

        // 创建确认按钮
        const confirmButton = new ButtonBuilder()
            .setCustomId('confirm_lockdown')
            .setLabel(action === 'enable' ? '确认闭关' : '确认开放')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder()
            .addComponents(confirmButton);

        // 发送确认消息
        const response = await interaction.editReply({
            embeds: [{
                color: 0xff0000,
                title: '⚠️ 操作确认',
                description: action === 'enable' ? 
                    '你确定要暂停服务器的邀请功能吗？\n\n**⚠️ 警告：开启后将无法使用邀请链接！**' :
                    '你确定要恢复服务器的邀请功能吗？',
                fields: [
                    {
                        name: '操作',
                        value: action === 'enable' ? '暂停邀请' : '恢复邀请',
                        inline: true
                    },
                    {
                        name: '执行人',
                        value: `<@${interaction.user.id}>`,
                        inline: true
                    },
                    {
                        name: '原因',
                        value: reason,
                        inline: false
                    }
                ],
                footer: {
                    text: '此确认按钮将在5分钟后失效'
                }
            }],
            components: [row]
        });

        try {
            const confirmation = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 300000
            });

            if (confirmation.customId === 'confirm_lockdown') {
                await confirmation.deferUpdate();
                await interaction.editReply({
                    content: '⏳ 正在处理...',
                    components: [],
                    embeds: []
                });

                const features = guild.features;
                if (action === 'enable') {
                    // 启用邀请暂停
                    if (!features.includes('INVITES_DISABLED')) {
                        await guild.edit({
                            features: [...features, 'INVITES_DISABLED']
                        });
                        
                        // 发送管理日志
                        await sendModerationLog(interaction.client, guildConfig.moderationLogThreadId, {
                            title: '🔒 服务器邀请功能已暂停',
                            executorId: interaction.user.id,
                            threadName: '服务器邀请管理',
                            threadUrl: interaction.channel.url,
                            reason: reason
                        });

                        logTime(`管理员 ${interaction.user.tag} 暂停了服务器 ${guild.name} 的邀请功能`);
                        await interaction.editReply({
                            content: '✅ 已成功暂停服务器邀请功能',
                            components: [],
                            embeds: []
                        });
                    } else {
                        await interaction.editReply({
                            content: '❓ 服务器邀请功能已经处于暂停状态',
                            components: [],
                            embeds: []
                        });
                    }
                } else {
                    // 禁用邀请暂停
                    if (features.includes('INVITES_DISABLED')) {
                        await guild.edit({
                            features: features.filter(f => f !== 'INVITES_DISABLED')
                        });

                        // 发送管理日志
                        await sendModerationLog(interaction.client, guildConfig.moderationLogThreadId, {
                            title: '🔓 服务器邀请功能已恢复',
                            executorId: interaction.user.id,
                            threadName: '服务器邀请管理',
                            threadUrl: interaction.channel.url,
                            reason: reason
                        });

                        logTime(`管理员 ${interaction.user.tag} 恢复了服务器 ${guild.name} 的邀请功能`);
                        await interaction.editReply({
                            content: '✅ 已成功恢复服务器邀请功能',
                            components: [],
                            embeds: []
                        });
                    } else {
                        await interaction.editReply({
                            content: '❓ 服务器邀请功能已经处于开启状态',
                            components: [],
                            embeds: []
                        });
                    }
                }
            }
        } catch (error) {
            if (error.code === 'InteractionCollectorError') {
                await interaction.editReply({
                    embeds: [{
                        color: 0x808080,
                        title: '❌ 确认已超时',
                        description: '操作已取消。如需继续请重新执行命令。',
                    }],
                    components: []
                });
            } else {
                await handleCommandError(interaction, error, '暂停邀请');
            }
        }
    },
}; 