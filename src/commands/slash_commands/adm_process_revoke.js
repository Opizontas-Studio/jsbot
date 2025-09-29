import { SlashCommandBuilder } from 'discord.js';
import CourtService from '../services/courtService.js';
import { handleCommandError } from '../utils/helper.js';

// 使用已有的紧急处理身份组ID
const EMERGENCY_ROLE_IDS = ['1289224017789583453', '1337441650137366705', '1336734406609473720'];

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('撤销议事')
        .setDescription('紧急撤销指定的议事流程')
        .addStringOption(option => option.setName('流程id').setDescription('要撤销的议事流程ID').setRequired(true)),

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

            const processId = interaction.options.getString('流程id');

            // 使用CourtService撤销流程
            const result = await CourtService.revokeProcess({
                processId: processId,
                revokedBy: interaction.user,
                isAdmin: true,
                client: interaction.client,
            });

            await interaction.editReply({
                content: result.success ? result.message : `❌ ${result.message}`,
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '撤销议事');
        }
    },
};
