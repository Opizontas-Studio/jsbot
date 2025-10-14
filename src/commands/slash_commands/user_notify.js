import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { handleCommandError, validateImageFile } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

// 定义颜色映射
const COLORS = {
    蓝色: 0x0099ff,
    绿色: 0x00ff00,
    紫色: 0x9b59b6,
    粉色: 0xff69b4,
    青色: 0x00ffff,
    橙色: 0xffa500,
    黄色: 0xffff00,
    灰色: 0x808080,
};

export default {
    cooldown: 10,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('发送通知')
        .setDescription('在当前频道发送一个通知控件，冷却60秒，请谨慎使用')
        .addStringOption(
            option => option.setName('标题').setDescription('通知的标题').setRequired(true).setMaxLength(256), // Discord embed标题最大长度
        )
        .addStringOption(
            option => option.setName('内容').setDescription('通知的具体内容').setRequired(true).setMaxLength(4096), // Discord embed描述最大长度
        )
        .addStringOption(option =>
            option
                .setName('通知类型')
                .setDescription('选择通知的类型（仅限在自己的论坛作品中使用@功能）')
                .setRequired(true)
                .addChoices(
                    { name: '无', value: 'none' },
                    { name: '在线关注者', value: 'here' },
                    { name: '所有关注者', value: 'everyone' },
                ),
        )
        .addAttachmentOption(option =>
            option
                .setName('图片')
                .setDescription('要显示的图片（可选，支持jpg、jpeg、png、gif或webp格式）')
                .setRequired(false),
        )
        .addStringOption(option =>
            option
                .setName('颜色')
                .setDescription('通知的颜色（默认蓝色）')
                .setRequired(false)
                .addChoices(
                    { name: '蓝色', value: '蓝色' },
                    { name: '绿色', value: '绿色' },
                    { name: '紫色', value: '紫色' },
                    { name: '粉色', value: '粉色' },
                    { name: '青色', value: '青色' },
                    { name: '橙色', value: '橙色' },
                    { name: '黄色', value: '黄色' },
                    { name: '灰色', value: '灰色' },
                ),
        ),

    async execute(interaction) {
        try {
            const channel = interaction.channel;
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

            // 获取参数
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('内容');
            const imageAttachment = interaction.options.getAttachment('图片');
            const selectedColor = interaction.options.getString('颜色') ?? '蓝色';
            const notifyType = interaction.options.getString('通知类型') ?? 'none';

            // 验证图片附件
            if (imageAttachment) {
                const { isValid, error } = validateImageFile(imageAttachment);
                if (!isValid) {
                    await interaction.editReply({
                        content: `❌ ${error}`,
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            }

            // 如果需要通知关注者，检查权限
            if (notifyType === 'here' || notifyType === 'everyone') {
                // 检查是否在论坛帖子中使用
                if (!channel.isThread() || channel.parent?.type !== ChannelType.GuildForum) {
                    await interaction.editReply({
                        content: '❌ 你只能在自己的作品中通知关注者',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 检查是否为帖子作者
                if (channel.ownerId !== interaction.user.id) {
                    await interaction.editReply({
                        content: '❌ 你只能在自己的作品中通知关注者',
                        flags: ['Ephemeral'],
                    });
                    return;
                }
            }

            // 检查用户是否是管理组成员
            const isModerator = interaction.member.roles.cache.some(role =>
                guildConfig.ModeratorRoleIds.includes(role.id),
            );

            const embed = {
                color: COLORS[selectedColor],
                title: title,
                description: description,
                timestamp: new Date(),
                footer: {
                    text: isModerator
                        ? `由管理员 ${interaction.member.displayName} 发送`
                        : `由 ${interaction.member.displayName} 发送`,
                },
            };

            // 如果提供了图片附件，添加图片
            if (imageAttachment) {
                embed.image = { url: imageAttachment.url };
            }

            // 构建发送消息的选项
            const sendOptions = { embeds: [embed] };
            if (notifyType === 'everyone') {
                sendOptions.content = '@everyone';
                logTime(`[发送通知] ${interaction.user.tag} 在 ${channel.name} 通知了所有关注者`);
            } else if (notifyType === 'here') {
                sendOptions.content = '@here';
                logTime(`[发送通知] ${interaction.user.tag} 在 ${channel.name} 通知了在线关注者`);
            }

            await channel.send(sendOptions);

            await interaction.editReply({
                content: '✅ 通知已发送',
            });
        } catch (error) {
            await handleCommandError(interaction, error, '发送通知');
        }
    },
};
