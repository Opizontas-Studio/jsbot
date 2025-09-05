import { SlashCommandBuilder } from 'discord.js';
import { checkModeratorPermission, handleCommandError, validateImageFile } from '../utils/helper.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('提交证据')
        .setDescription('提交或修改处罚的文字和图片解释说明')
        .addStringOption(option =>
            option
                .setName('消息id')
                .setDescription('要修改的消息ID（如果要修改现有消息）')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('文本内容')
                .setDescription('要附带的文本内容')
                .setRequired(false)
                .setMaxLength(2000) // Discord消息内容最大长度
        )
        .addAttachmentOption(option =>
            option
                .setName('图片1')
                .setDescription('要上传的图片1（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片2')
                .setDescription('要上传的图片2（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片3')
                .setDescription('要上传的图片3（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片4')
                .setDescription('要上传的图片4（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片5')
                .setDescription('要上传的图片5（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片6')
                .setDescription('要上传的图片6（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片7')
                .setDescription('要上传的图片7（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片8')
                .setDescription('要上传的图片8（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option
                .setName('图片9')
                .setDescription('要上传的图片9（支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

            if (!guildConfig) {
                await interaction.editReply({
                    content: '❌ 无法获取服务器配置',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查管理员权限
            if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
            }

            // 检查是否配置了 moderationLogThreadId
            if (!guildConfig.moderationLogThreadId) {
                await interaction.editReply({
                    content: '❌ 服务器未配置管理日志频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取参数
            const messageId = interaction.options.getString('消息id');
            const textContent = interaction.options.getString('文本内容');

            // 收集所有图片附件
            const imageAttachments = [];
            for (let i = 1; i <= 9; i++) {
                const attachment = interaction.options.getAttachment(`图片${i}`);
                if (attachment) {
                    imageAttachments.push(attachment);
                }
            }

            // 检查是否至少提供了文本内容或图片
            if (!textContent && imageAttachments.length === 0) {
                await interaction.editReply({
                    content: '❌ 必须提供文本内容或至少一张图片',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 验证所有图片附件
            for (const attachment of imageAttachments) {
                const { isValid, error } = validateImageFile(attachment);
                if (!isValid) {
                    await interaction.editReply({
                        content: `❌ ${error}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            }

            // 获取管理日志频道
            let logChannel;
            try {
                logChannel = await interaction.client.channels.fetch(guildConfig.moderationLogThreadId);
            } catch (error) {
                await interaction.editReply({
                    content: '❌ 无法访问管理日志频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 构建消息内容
            const messageContent = textContent || '';
            const files = imageAttachments.map(attachment => ({
                attachment: attachment.url,
                name: attachment.name,
            }));

            try {
                if (messageId) {
                    // 修改模式：尝试修改现有消息
                    const targetMessage = await logChannel.messages.fetch(messageId);

                    // 检查消息是否存在且是由bot发送的
                    if (!targetMessage) {
                        await interaction.editReply({
                            content: '❌ 找不到指定的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    if (targetMessage.author.id !== interaction.client.user.id) {
                        await interaction.editReply({
                            content: '❌ 只能修改由机器人发送的消息',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 修改消息
                    await targetMessage.edit({
                        content: messageContent,
                        files: files,
                    });

                    await interaction.editReply({
                        content: '✅ 证据消息已成功修改',
                        flags: ['Ephemeral'],
                    });
                } else {
                    // 发送模式：发送新消息
                    await logChannel.send({
                        content: messageContent,
                        files: files,
                    });

                    await interaction.editReply({
                        content: '✅ 证据已成功提交到管理日志频道',
                        flags: ['Ephemeral'],
                    });
                }
            } catch (error) {
                if (error.code === 10008) { // Unknown Message
                    await interaction.editReply({
                        content: '❌ 找不到指定的消息ID',
                        flags: ['Ephemeral'],
                    });
                } else if (error.code === 50035) { // Invalid Form Body
                    await interaction.editReply({
                        content: '❌ 消息内容或附件格式无效',
                        flags: ['Ephemeral'],
                    });
                } else {
                    throw error; // 其他错误继续抛出
                }
            }
        } catch (error) {
            await handleCommandError(interaction, error, '提交证据');
        }
    },
};
