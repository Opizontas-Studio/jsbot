const { SlashCommandBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { logTime, handleCommandError, checkPermission, handlePermissionResult } = require('../utils/helper');
const { globalRateLimiter } = require('../utils/concurrency');

module.exports = {
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
                )),

    async execute(interaction, guildConfig) {
        // 权限检查
        if (!checkPermission(interaction.member, guildConfig.allowedRoleIds)) {
            await interaction.reply({
                content: '你没有权限使用此命令',
                flags: ['Ephemeral']
            });
            return;
        }

        await interaction.deferReply({ flags: ['Ephemeral'] });
        const action = interaction.options.getString('操作');
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

                await globalRateLimiter.withRateLimit(async () => {
                    const features = guild.features;
                    if (action === 'enable') {
                        // 启用邀请暂停
                        if (!features.includes('INVITES_DISABLED')) {
                            await guild.edit({
                                features: [...features, 'INVITES_DISABLED']
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
                });
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