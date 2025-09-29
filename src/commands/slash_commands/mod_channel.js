import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

/**
 * 管理命令 - 管理频道设置
 * 提供修改频道名称、主题、限速、NSFW等基础设置的功能
 * 注意：部分设置仅适用于特定类型的频道
 */
export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('管理频道')
        .setDescription('频道管理相关命令')
        .addSubcommand(subcommand =>
            subcommand
                .setName('编辑')
                .setDescription('修改频道的各项设置')
                .addChannelOption(option => option.setName('频道').setDescription('要管理的频道').setRequired(true))
                .addStringOption(option =>
                    option.setName('名称').setDescription('新的频道名称').setMinLength(1).setMaxLength(100),
                )
                .addStringOption(option => option.setName('主题').setDescription('频道主题/描述').setMaxLength(1024))
                .addIntegerOption(option =>
                    option.setName('限速').setDescription('发言限速时间(秒)').setMinValue(0).setMaxValue(21600),
                )
                .addBooleanOption(option => option.setName('nsfw').setDescription('是否为年龄限制频道'))
                .addIntegerOption(option =>
                    option
                        .setName('自动归档')
                        .setDescription('帖子自动归档时间(分钟)')
                        .addChoices(
                            { name: '1小时', value: 60 },
                            { name: '1天', value: 1440 },
                            { name: '3天', value: 4320 },
                            { name: '1周', value: 10080 },
                        ),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('创建赛事')
                .setDescription('创建一个新的赛事频道')
                .addStringOption(option =>
                    option
                        .setName('名称')
                        .setDescription('赛事频道名称')
                        .setRequired(true)
                        .setMinLength(1)
                        .setMaxLength(100),
                )
                .addStringOption(option => option.setName('主题').setDescription('赛事频道描述').setMaxLength(1024)),
        ),

    async execute(interaction, guildConfig) {
        try {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === '编辑') {
                // 编辑频道需要管理员权限
                if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                    return;
                }
                await handleEditChannel(interaction);
            } else if (subcommand === '创建赛事') {
                // 创建赛事频道需要版主权限
                if (!(await checkAndHandlePermission(interaction, guildConfig.ModeratorRoleIds))) {
                    return;
                }
                await handleCreateEventChannel(interaction, guildConfig);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '管理频道');
        }
    },
};

async function handleEditChannel(interaction) {
    const targetChannel = interaction.options.getChannel('频道');
    const newName = interaction.options.getString('名称');
    const newTopic = interaction.options.getString('主题');
    const newSlowMode = interaction.options.getInteger('限速');
    const newNsfw = interaction.options.getBoolean('nsfw');
    const newAutoArchive = interaction.options.getInteger('自动归档');

    // 构建更新对象
    const updateData = {};
    if (newName) updateData.name = newName;
    if (newTopic) updateData.topic = newTopic;
    if (newSlowMode !== null) updateData.rateLimitPerUser = newSlowMode;
    if (newNsfw !== null) updateData.nsfw = newNsfw;
    if (newAutoArchive) updateData.defaultAutoArchiveDuration = newAutoArchive;

    // 如果没有任何更改
    if (Object.keys(updateData).length === 0) {
        await interaction.editReply({
            content: '❌ 请至少指定一个要修改的设置',
            flags: ['Ephemeral'],
        });
        return;
    }

    // 更新频道设置
    await targetChannel.edit(updateData);

    // 构建更改日志
    const changes = [];
    if (newName) changes.push(`名称: ${targetChannel.name} → ${newName}`);
    if (newTopic) changes.push(`主题: ${targetChannel.topic || '无'} → ${newTopic}`);
    if (newSlowMode !== null) changes.push(`限速: ${targetChannel.rateLimitPerUser}秒 → ${newSlowMode}秒`);
    if (newNsfw !== null) changes.push(`NSFW: ${targetChannel.nsfw ? '是' : '否'} → ${newNsfw ? '是' : '否'}`);
    if (newAutoArchive)
        changes.push(`自动归档: ${targetChannel.defaultAutoArchiveDuration}分钟 → ${newAutoArchive}分钟`);

    await interaction.editReply({
        content: `✅ 已成功修改频道 <#${targetChannel.id}> 的设置\n${changes.join('\n')}`,
    });

    logTime(`用户 ${interaction.user.tag} 修改了频道 ${targetChannel.name} 的设置`);
}

async function handleCreateEventChannel(interaction, guildConfig) {
    const channelName = interaction.options.getString('名称');
    const channelTopic = interaction.options.getString('主题');

    if (!guildConfig.eventsCategoryId) {
        await interaction.editReply({
            content: '❌ 服务器未配置赛事类别，请联系管理员设置',
            flags: ['Ephemeral'],
        });
        return;
    }

    try {
        const channel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            topic: channelTopic,
            parent: guildConfig.eventsCategoryId,
        });

        await interaction.editReply({
            content: `✅ 已成功创建赛事频道 <#${channel.id}>`,
        });

        logTime(`用户 ${interaction.user.tag} 创建了赛事频道 ${channelName}`);
    } catch (error) {
        if (error.code === 50013) {
            await interaction.editReply({
                content: '❌ 机器人缺少创建频道的权限',
                flags: ['Ephemeral'],
            });
        } else {
            throw error;
        }
    }
}
