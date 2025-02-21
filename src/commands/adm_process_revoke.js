import { SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 使用已有的紧急处理身份组ID
const EMERGENCY_ROLE_IDS = ['1289224017789583453', '1337441650137366705'];

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('撤销议事')
        .setDescription('紧急撤销指定的议事流程')
        .addStringOption(option =>
            option
                .setName('流程id')
                .setDescription('要撤销的议事流程ID')
                .setRequired(true)
        ),

    async execute(interaction) {
        try {
            // 检查权限
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const hasEmergencyRole = member.roles.cache.some(role => EMERGENCY_ROLE_IDS.includes(role.id));

            if (!hasEmergencyRole) {
                await interaction.editReply({
                    content: '❌ 你没有权限执行此命令',
                    flags: ['Ephemeral']
                });
                return;
            }

            const processId = interaction.options.getString('流程id');

            // 获取流程记录
            const process = await ProcessModel.getProcessById(parseInt(processId));
            if (!process) {
                await interaction.editReply({
                    content: '❌ 找不到指定的议事流程',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 检查流程状态
            if (process.status === 'completed' || process.status === 'cancelled') {
                await interaction.editReply({
                    content: '❌ 该议事流程已结束，无需撤销',
                    flags: ['Ephemeral']
                });
                return;
            }

            // 尝试删除原议事消息
            try {
                const channel = await interaction.guild.channels.fetch(interaction.guild.config.courtSystem.courtChannelId);
                const message = await channel.messages.fetch(process.messageId);
                await message.delete();
            } catch (error) {
                logTime(`删除议事消息失败 [流程ID: ${processId}]: ${error.message}`, true);
                // 继续执行，因为消息可能已被删除
            }

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason: `由 ${interaction.user.tag} 紧急撤销`,
            });

            // 取消计时器
            await globalTaskScheduler.getProcessScheduler().cancelProcess(process.id);

            // 记录操作日志
            logTime(`议事流程 ${processId} 已被 ${interaction.user.tag} 紧急撤销`);

            await interaction.editReply({
                content: '✅ 议事流程已成功撤销',
                flags: ['Ephemeral']
            });

        } catch (error) {
            await handleCommandError(interaction, error, '撤销议事');
        }
    },
}; 