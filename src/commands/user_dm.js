import { SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const COLORS = {
    蓝色: 0x0099ff,
    绿色: 0x00ff00,
    紫色: 0x9b59b6,
    粉色: 0xff69b4,
    青色: 0x00ffff,
};

export default {
    cooldown: 60,
    data: new SlashCommandBuilder()
        .setName('私聊通知')
        .setDescription('通过机器人向指定用户发送私聊通知')
        .addUserOption(option => option.setName('目标用户').setDescription('要发送私聊通知的用户').setRequired(true))
        .addStringOption(option =>
            option.setName('标题').setDescription('通知的标题').setRequired(true).setMaxLength(256),
        )
        .addStringOption(option =>
            option.setName('内容').setDescription('通知的具体内容').setRequired(true).setMaxLength(4096),
        )
        .addStringOption(option => option.setName('图片').setDescription('要显示的图片URL（可选）').setRequired(false))
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
                ),
        ),

    async execute(interaction) {
        try {
            // 获取目标用户
            const targetUser = interaction.options.getUser('目标用户');

            // 检查是否是自己
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply({
                    content: '❌ 不能向自己发送私聊通知',
                });
                return;
            }

            // 检查是否是机器人
            if (targetUser.bot) {
                await interaction.editReply({
                    content: '❌ 不能向机器人发送私聊通知',
                });
                return;
            }

            // 获取参数
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('内容');
            const imageUrl = interaction.options.getString('图片');
            const selectedColor = interaction.options.getString('颜色') ?? '蓝色';

            // 创建接收者的embed
            const receiverEmbed = {
                color: COLORS[selectedColor],
                title: title,
                description: description,
                timestamp: new Date(),
                footer: {
                    text: `来自 ${interaction.user.tag} (通过 ${interaction.guild.name})`,
                },
            };

            if (imageUrl) {
                receiverEmbed.image = { url: imageUrl };
            }

            try {
                // 向接收者的私聊发送消息
                const receiverDM = await targetUser.createDM();
                await receiverDM.send({ embeds: [receiverEmbed] });

                await interaction.editReply({
                    content: `✅ 私聊通知已发送给 ${targetUser.tag}`,
                });

                // 记录日志
                logTime(`${interaction.user.tag} 通过bot向 ${targetUser.tag} 发送了一条私聊通知`);
            } catch (error) {
                if (error.code === 50007) {
                    await interaction.editReply({
                        content: `❌ 无法发送私聊消息给 ${targetUser.tag}。该用户可能已关闭私聊权限。`,
                    });
                } else {
                    throw error;
                }
            }
        } catch (error) {
            await handleCommandError(interaction, error, '发送私聊通知');
        }
    },
};
