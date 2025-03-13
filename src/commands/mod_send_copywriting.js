import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { handleConfirmationButton } from '../handlers/buttons.js';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('发送文案')
        .setDescription('发送预设的文案内容')
        .addIntegerOption(option =>
            option
                .setName('编号')
                .setDescription('文案编号(1-99)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(99),
        ),

    async execute(interaction, guildConfig) {
        // 需要版主或管理员权限
        if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
        }

        try {
            const copywritingNumber = interaction.options.getInteger('编号');
            const filePath = path.join(process.cwd(), 'data', 'copywriting', `${copywritingNumber}.txt`);

            // 读取文案内容
            let content;
            try {
                content = await fs.readFile(filePath, 'utf-8');
            } catch (error) {
                await interaction.editReply({
                    content: `❌ 无法读取文案文件：${error.message}`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            if (!content.trim()) {
                await interaction.editReply({
                    content: '❌ 文案内容为空',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取前50个字符作为预览
            const preview = content.slice(0, 50) + (content.length > 50 ? '...' : '');

            // 使用确认按钮
            await handleConfirmationButton({
                interaction,
                customId: 'confirm_send_copywriting',
                buttonLabel: '确认发送',
                embed: {
                    color: 0x0099ff,
                    title: '📝 文案发送确认',
                    description: '你确定要发送这篇文案吗？',
                    fields: [
                        {
                            name: '文案预览',
                            value: preview,
                            inline: false,
                        },
                        {
                            name: '文案编号',
                            value: `${copywritingNumber}`,
                            inline: true,
                        },
                        {
                            name: '执行人',
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        },
                    ],
                },
                onConfirm: async confirmation => {
                    await confirmation.deferUpdate();
                    await interaction.editReply({
                        content: '⏳ 正在发送文案...',
                        components: [],
                        embeds: [],
                    });

                    // 按行分割文本
                    const lines = content.split('\n');
                    let currentMessage = '';
                    
                    // 逐行构建消息，确保每条消息不超过2000字符
                    for (const line of lines) {
                        if (currentMessage.length + line.length + 1 > 2000) {
                            // 发送当前消息
                            await interaction.channel.send(currentMessage);
                            currentMessage = line + '\n';
                        } else {
                            currentMessage += line + '\n';
                        }
                    }

                    // 发送最后一条消息（如果有）
                    if (currentMessage.trim()) {
                        await interaction.channel.send(currentMessage);
                    }

                    await interaction.editReply({
                        content: '✅ 文案发送完成',
                        components: [],
                        embeds: [],
                    });
                    logTime(`文案发送完成 - 服务器: ${interaction.guild.name}, 文案编号: ${copywritingNumber}`);
                },
                onError: async error => {
                    await handleCommandError(interaction, error, '发送文案');
                },
            });
        } catch (error) {
            await handleCommandError(interaction, error, '发送文案');
        }
    },
}; 