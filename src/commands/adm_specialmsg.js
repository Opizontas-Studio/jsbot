import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('创建特殊消息')
        .setDescription('创建特殊功能消息（如创作者申请、身份组同步）')
        .addStringOption(option =>
            option
                .setName('类型')
                .setDescription('选择消息类型')
                .setRequired(true)
                .addChoices(
                    { name: '创作者申请', value: 'creator_application' },
                    { name: '身份组同步', value: 'role_sync' }
                )
        )
        .addChannelOption(option =>
            option
                .setName('频道')
                .setDescription('选择要发送消息的频道')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
        ),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const messageType = interaction.options.getString('类型');
        const targetChannel = interaction.options.getChannel('频道');

        try {
            await interaction.deferReply();

            // 创建不同类型的消息
            if (messageType === 'creator_application') {
                await createCreatorApplicationMessage(interaction, targetChannel);
            } else if (messageType === 'role_sync') {
                await createRoleSyncMessage(interaction, targetChannel);
            }

        } catch (error) {
            await handleCommandError(interaction, error, '创建特殊消息');
        }
    },
};

/**
 * 创建创作者申请消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 */
async function createCreatorApplicationMessage(interaction, channel) {
    // 创建申请按钮
    const button = new ButtonBuilder()
        .setCustomId('apply_creator_role')
        .setLabel('申请')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('创作者身份组自助申请')
        .setDescription(
            '请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您在所有服务器添加创作者身份组。'
        )
        .setColor(0x0099ff);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了创作者申请消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建创作者申请消息`
    });
}

/**
 * 创建身份组同步消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 */
async function createRoleSyncMessage(interaction, channel) {
    // 创建同步按钮
    const button = new ButtonBuilder()
        .setCustomId('sync_roles')
        .setLabel('同步身份组')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('身份组手动同步')
        .setDescription([
            '在您加入时，系统已进行了类脑服务器间身份组的自动同步，但由于API速率限制，可能存在部分未同步。',
            '若您发现自身身份组未同步，点击下方按钮可手动同步，而不需要经过准入答题。',
            '**可同步的身份组：**',
            '• 已验证 - 答题通过',
            '• 创作者 - 创作者',
            '• 赛博议员 - 议员',
            '• 管理组 - 所有管理组',
        ].join('\n'))
        .setColor(0x0099ff);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了身份组同步消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建身份组同步消息`
    });
} 