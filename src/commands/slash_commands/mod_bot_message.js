import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { checkModeratorPermission, handleCommandError, validateImageFile } from '../../utils/helper.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('提交bot消息')
        .setDescription('提交或修改一条BOT消息')
        .addChannelOption(option =>
            option
                .setName('频道')
                .setDescription('选择要发送消息的频道（留空则使用默认管理日志频道）')
                .setRequired(false)
                .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
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

            // 检查管理员权限
            if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
            }

            // 获取参数
            const targetChannel = interaction.options.getChannel('频道');
            const textContent = interaction.options.getString('文本内容');

            // 确定目标频道：用户选择的频道 或 命令执行频道
            let logChannel;
            if (targetChannel) {
                logChannel = targetChannel;
            } else {
                // 默认发送到命令执行的频道
                logChannel = interaction.channel;
            }

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


            // 构建消息内容
            const messageContent = textContent || '';
            const files = imageAttachments.map(attachment => ({
                attachment: attachment.url,
                name: attachment.name,
            }));

            // 发送新消息
            await logChannel.send({
                content: messageContent,
                files: files,
            });

            const channelMention = targetChannel ? `<#${logChannel.id}>` : '当前频道';
            await interaction.editReply({
                content: `✅ 文本已成功提交到${channelMention}`,
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '提交证据');
        }
    },
};
