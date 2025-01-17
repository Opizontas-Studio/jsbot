const { SlashCommandBuilder } = require('discord.js');
const { handleCommandError } = require('../utils/helper');
const { globalRequestQueue } = require('../utils/concurrency');

// 定义颜色映射
const COLORS = {
    '蓝色': 0x0099ff,
    '绿色': 0x00ff00,
    '紫色': 0x9b59b6,
    '粉色': 0xff69b4,
    '青色': 0x00ffff,
};

module.exports = {
    // 设置命令冷却时间为60秒
    cooldown: 60,
    
    // 定义命令
    data: new SlashCommandBuilder()
        .setName('发送通知')
        .setDescription('在当前频道发送一个通知控件，冷却60秒，请谨慎使用')
        .addStringOption(option =>
            option.setName('标题')
                .setDescription('通知的标题')
                .setRequired(true)
                .setMaxLength(256) // Discord embed标题最大长度
        )
        .addStringOption(option =>
            option.setName('内容')
                .setDescription('通知的具体内容')
                .setRequired(true)
                .setMaxLength(4096) // Discord embed描述最大长度
        )
        .addStringOption(option =>
            option.setName('图片')
                .setDescription('要显示的图片URL（可选）')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('颜色')
                .setDescription('通知的颜色（默认蓝色）')
                .setRequired(false)
                .addChoices(
                    { name: '蓝色', value: '蓝色' },
                    { name: '绿色', value: '绿色' },
                    { name: '紫色', value: '紫色' },
                    { name: '粉色', value: '粉色' },
                    { name: '青色', value: '青色' },
                )
        )
        .addBooleanOption(option =>
            option.setName('匿名')
                .setDescription('是否匿名发送（不显示发送者）')
                .setRequired(false)
        ),

    async execute(interaction) {
        try {
            // 立即发送延迟响应
            await interaction.deferReply({ flags: ['Ephemeral'] });

            const channel = interaction.channel;
            
            // 获取参数
            const title = interaction.options.getString('标题');
            const description = interaction.options.getString('内容');
            const imageUrl = interaction.options.getString('图片');
            const isAnonymous = interaction.options.getBoolean('匿名') ?? false;
            const selectedColor = interaction.options.getString('颜色') ?? '蓝色';

            // 加入队列发送通知
            await globalRequestQueue.add(async () => {
                const embed = {
                    color: COLORS[selectedColor],
                    title: title,
                    description: description,
                    timestamp: new Date(),
                };
                
                // 如果提供了图片URL，添加图片
                if (imageUrl) {
                    embed.image = { url: imageUrl };
                }
                
                // 如果不是匿名，添加发送者信息
                if (!isAnonymous) {
                    embed.footer = {
                        text: `由 ${interaction.user.tag} 发送`
                    };
                }

                await channel.send({ embeds: [embed] });

                await interaction.editReply({
                    content: '✅ 通知已发送'
                });
            }, 2); // 高优先级

        } catch (error) {
            await handleCommandError(interaction, error, '发送通知');
        }
    },
}; 