import { SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 使用已有的紧急处理身份组ID
const EMERGENCY_ROLE_IDS = ['1289224017789583453', '1337441650137366705', '1336734406609473720'];

export default {
    cooldown: 3,
    data: new SlashCommandBuilder()
        .setName('删除消息')
        .setDescription('通过消息链接删除指定消息')
        .addStringOption(option => option.setName('消息链接').setDescription('要删除的消息链接').setRequired(true)),

    async execute(interaction) {
        try {
            // 检查权限
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const hasEmergencyRole = member.roles.cache.some(role => EMERGENCY_ROLE_IDS.includes(role.id));

            if (!hasEmergencyRole) {
                await interaction.editReply({
                    content: '❌ 你没有权限执行此命令',
                    flags: ['Ephemeral'],
                });
                return;
            }

            const messageLink = interaction.options.getString('消息链接');

            // 解析消息链接
            // 消息链接格式: https://discord.com/channels/服务器ID/频道ID/消息ID
            const matches = messageLink.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
            if (!matches) {
                await interaction.editReply({
                    content: '❌ 无效的消息链接格式',
                    flags: ['Ephemeral'],
                });
                return;
            }

            const [, guildId, channelId, messageId] = matches;

            // 获取消息并删除
            const channel = await interaction.client.channels.fetch(channelId);
            if (!channel) {
                await interaction.editReply({
                    content: '❌ 找不到指定的频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            const message = await channel.messages.fetch(messageId);
            if (!message) {
                await interaction.editReply({
                    content: '❌ 找不到指定的消息',
                    flags: ['Ephemeral'],
                });
                return;
            }

            await message.delete();
            logTime(`${interaction.user.tag} 删除了消息 ${messageId} (频道: ${channel.name})`);

            await interaction.editReply({
                content: '✅ 消息已成功删除',
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '删除消息');
        }
    },
};
