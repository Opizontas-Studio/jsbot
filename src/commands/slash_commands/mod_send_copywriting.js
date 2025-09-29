import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('发送文案')
        .setDescription('发送预设的文案内容')
        .addChannelOption(option =>
            option
                .setName('频道')
                .setDescription('要发送文案的目标频道')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('编号')
                .setDescription('文案编号(1-99)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(99)
                .setAutocomplete(true),
        )
        .addAttachmentOption(option =>
            option.setName('上传文件').setDescription('上传txt或md文件作为文案内容(最大30KB)').setRequired(false),
        ),

    // 处理自动补全请求
    async autocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const copywritingDir = path.join(process.cwd(), 'data', 'copywriting');

            // 确保目录存在
            try {
                await fs.mkdir(copywritingDir, { recursive: true });
            } catch (error) {
                // 忽略目录已存在的错误
            }

            // 读取目录
            let files;
            try {
                files = await fs.readdir(copywritingDir);
            } catch (error) {
                console.error(`读取文案目录失败: ${error}`);
                return interaction.respond([]);
            }

            // 过滤出.txt文件并提取编号
            const fileNumbers = files
                .filter(file => file.endsWith('.txt'))
                .map(file => {
                    const numberStr = file.replace('.txt', '');
                    return parseInt(numberStr, 10);
                })
                .filter(number => !isNaN(number) && number >= 1 && number <= 99);

            // 如果没有文件，返回空数组
            if (fileNumbers.length === 0) {
                return interaction.respond([]);
            }

            // 根据输入筛选编号
            const filtered = fileNumbers.filter(number =>
                focusedValue ? number.toString().startsWith(focusedValue) : true,
            );

            // 读取每个文件的内容，获取前15个字符
            const options = await Promise.all(
                filtered.slice(0, 25).map(async number => {
                    const filePath = path.join(copywritingDir, `${number}.txt`);
                    try {
                        // 明确指定UTF-8编码读取文件
                        const content = await fs.readFile(filePath, { encoding: 'utf-8' });
                        // 获取文案的前15个字符（如果有）
                        const preview = content.trim().slice(0, 15);
                        // 格式化展示名称：编号-文案预览
                        return {
                            name: `${number}-${preview}${content.length > 15 ? '...' : ''}`,
                            value: number,
                        };
                    } catch (error) {
                        // 如果无法读取文件，只显示编号
                        console.error(`读取文件 ${number}.txt 失败: ${error.message}`);
                        return {
                            name: `${number}号文案`,
                            value: number,
                        };
                    }
                }),
            );

            await interaction.respond(options);
        } catch (error) {
            console.error(`自动补全处理错误: ${error}`);
            // 返回空列表，避免交互失败
            await interaction.respond([]);
        }
    },

    async execute(interaction, guildConfig) {
        // 需要版主或管理员权限
        if (!(await checkModeratorPermission(interaction, guildConfig))) {
            return;
        }

        try {
            const targetChannel = interaction.options.getChannel('频道');
            const attachment = interaction.options.getAttachment('上传文件');
            const copywritingNumber = interaction.options.getInteger('编号');

            // 检查频道类型是否支持发送消息
            if (!targetChannel.isTextBased()) {
                await interaction.editReply({
                    content: '❌ 只能向文字频道发送文案',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查是否提供了至少一个内容参数
            if (!attachment && !copywritingNumber) {
                await interaction.editReply({
                    content: '❌ 请提供文案编号或上传文件',
                    flags: ['Ephemeral'],
                });
                return;
            }

            let content = '';
            let contentSource = '';

            // 优先处理上传文件
            if (attachment) {
                // 验证文件格式
                const fileExtension = attachment.name.split('.').pop().toLowerCase();
                if (!['txt', 'md'].includes(fileExtension)) {
                    await interaction.editReply({
                        content: '❌ 只支持 .txt 或 .md 格式的文件',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 验证文件大小 (30KB = 30 * 1024 = 30720 bytes)
                if (attachment.size > 30720) {
                    await interaction.editReply({
                        content: '❌ 文件大小不能超过30KB',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 获取文件内容
                try {
                    const response = await fetch(attachment.url);
                    if (!response.ok) {
                        throw new Error(`获取文件失败: ${response.status} ${response.statusText}`);
                    }
                    content = await response.text();
                    contentSource = `上传的文件: ${attachment.name}`;
                } catch (error) {
                    await interaction.editReply({
                        content: `❌ 无法读取上传的文件: ${error.message}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            }
            // 如果没有上传文件或获取文件内容失败，则尝试使用文案编号
            else if (copywritingNumber) {
                const filePath = path.join(process.cwd(), 'data', 'copywriting', `${copywritingNumber}.txt`);

                // 读取文案内容，明确指定UTF-8编码
                try {
                    content = await fs.readFile(filePath, { encoding: 'utf-8' });
                    contentSource = `文案编号: ${copywritingNumber}`;
                } catch (error) {
                    await interaction.editReply({
                        content: `❌ 无法读取文案文件：${error.message}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
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
                            name: '文案来源',
                            value: contentSource,
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
                            // 发送当前消息到指定频道
                            await targetChannel.send(currentMessage);
                            currentMessage = line + '\n';
                        } else {
                            currentMessage += line + '\n';
                        }
                    }

                    // 发送最后一条消息（如果有）
                    if (currentMessage.trim()) {
                        await targetChannel.send(currentMessage);
                    }

                    await interaction.editReply({
                        content: `✅ 文案已发送至 <#${targetChannel.id}>`,
                        components: [],
                        embeds: [],
                    });
                    logTime(`文案发送完成 - 服务器: ${interaction.guild.name}, 目标频道: ${targetChannel.name}, 来源: ${contentSource}`);
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
