const { 
    Events, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    EmbedBuilder,
    ChannelType,
    Collection 
} = require('discord.js');
const { logTime } = require('../utils/helper');
const fs = require('node:fs');
const path = require('node:path');

// 创建冷却时间集合
const cooldowns = new Collection();

// 处理创建申请消息
async function createApplicationMessage(client) {
    // 读取消息ID配置
    const messageIdsPath = path.join(__dirname, '..', 'data', 'messageIds.json');
    let messageIds;
    try {
        messageIds = JSON.parse(fs.readFileSync(messageIdsPath, 'utf8'));
        if (!messageIds.roleApplicationMessages) {
            messageIds.roleApplicationMessages = {};
        }
    } catch (error) {
        logTime(`读取消息ID配置失败: ${error}`, true);
        return;
    }

    // 为每个配置了 addRoleThread 的服务器创建申请消息
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        if (!guildConfig.addRoleThread || !guildConfig.creatorRoleId) continue;

        try {
            const channel = await client.channels.fetch(guildConfig.addRoleThread);
            if (!channel) continue;

            // 删除旧的申请消息
            const oldMessageId = messageIds.roleApplicationMessages[guildId];
            if (oldMessageId) {
                try {
                    const oldMessage = await channel.messages.fetch(oldMessageId);
                    if (oldMessage) {
                        await oldMessage.delete();
                        logTime(`已删除服务器 ${guildId} 的旧申请消息`);
                    }
                } catch (error) {
                    logTime(`删除旧申请消息失败: ${error}`, true);
                }
            }

            // 创建申请按钮
            const button = new ButtonBuilder()
                .setCustomId('apply_creator_role')
                .setLabel('申请')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(button);

            // 创建嵌入消息
            const embed = new EmbedBuilder()
                .setTitle('创作者身份组自助申请')
                .setDescription('请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您添加创作者身份组。')
                .setColor(0x0099FF);

            // 发送新消息并保存消息ID
            const newMessage = await channel.send({
                embeds: [embed],
                components: [row]
            });

            messageIds.roleApplicationMessages[guildId] = newMessage.id;
            
            // 保存更新后的消息ID配置
            fs.writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
            
            logTime(`已在服务器 ${guildId} 创建新的身份组申请消息`);
        } catch (error) {
            logTime(`在服务器 ${guildId} 创建身份组申请消息时出错: ${error}`, true);
        }
    }
}

// 处理按钮交互
async function handleButtonInteraction(interaction) {
    if (interaction.customId !== 'apply_creator_role') return;

    // 检查用户是否已有创作者身份组
    const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    
    if (member.roles.cache.has(guildConfig.creatorRoleId)) {
        await interaction.reply({
            content: '❌ 您已经拥有创作者身份组',
            flags: ['Ephemeral']
        });
        return;
    }

    // 检查冷却时间
    const now = Date.now();
    const cooldownKey = `roleapply:${interaction.user.id}`;
    const cooldownTime = cooldowns.get(cooldownKey);

    if (cooldownTime && now < cooldownTime) {
        const timeLeft = Math.ceil((cooldownTime - now) / 1000);
        await interaction.reply({
            content: `❌ 请等待 ${timeLeft} 秒后再次申请`,
            flags: ['Ephemeral']
        });
        return;
    }

    // 设置60秒冷却时间
    cooldowns.set(cooldownKey, now + 60000);
    setTimeout(() => cooldowns.delete(cooldownKey), 60000);

    // 显示申请表单
    const modal = new ModalBuilder()
        .setCustomId('creator_role_modal')
        .setTitle('创作者身份组申请');

    const threadLinkInput = new TextInputBuilder()
        .setCustomId('thread_link')
        .setLabel('请输入作品帖子链接')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：https://discord.com/channels/.../...')
        .setRequired(true);

    const firstActionRow = new ActionRowBuilder().addComponents(threadLinkInput);
    modal.addComponents(firstActionRow);

    await interaction.showModal(modal);
}

// 处理模态框提交
async function handleModalSubmit(interaction) {
    if (interaction.customId !== 'creator_role_modal') return;

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
        const threadLink = interaction.fields.getTextInputValue('thread_link');
        const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);

        if (!matches) {
            await interaction.editReply('❌ 无效的帖子链接格式');
            return;
        }

        const [, guildId, threadId] = matches;
        const guildConfig = interaction.client.guildManager.getGuildConfig(guildId);

        if (!guildConfig || !guildConfig.creatorRoleId) {
            await interaction.editReply('❌ 服务器配置错误');
            return;
        }

        // 再次检查用户是否已有身份组（防止在申请过程中被手动添加）
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(guildConfig.creatorRoleId)) {
            await interaction.editReply('❌ 您已经拥有创作者身份组');
            return;
        }

        const thread = await interaction.client.channels.fetch(threadId);
        
        if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
            await interaction.editReply('❌ 提供的链接不是论坛帖子');
            return;
        }

        // 获取首条消息
        const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
        const threadStarter = firstMessage.first();

        if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
            await interaction.editReply('❌ 您不是该帖子的作者');
            return;
        }

        // 获取反应数最多的表情
        let maxReactions = 0;
        threadStarter.reactions.cache.forEach(reaction => {
            const count = reaction.count;
            if (count > maxReactions) {
                maxReactions = count;
            }
        });

        // 准备审核日志
        const moderationChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
        const auditEmbed = {
            color: maxReactions >= 5 ? 0x00ff00 : 0xff0000,
            title: maxReactions >= 5 ? '✅ 创作者身份组申请通过' : '❌ 创作者身份组申请未通过',
            fields: [
                {
                    name: '申请者',
                    value: `<@${interaction.user.id}>`,
                    inline: true
                },
                {
                    name: '作品链接',
                    value: threadLink,
                    inline: true
                },
                {
                    name: '最高反应数',
                    value: `${maxReactions}`,
                    inline: true
                }
            ],
            timestamp: new Date(),
            footer: {
                text: '自动审核系统'
            }
        };

        if (maxReactions >= 5) {
            // 添加身份组
            await member.roles.add(guildConfig.creatorRoleId);
            await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');
            
            // 只有通过审核才发送日志
            if (moderationChannel) {
                await moderationChannel.send({ embeds: [auditEmbed] });
            }
            
            logTime(`用户 ${interaction.user.tag} 获得了创作者身份组`);
        } else {
            await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
        }

    } catch (error) {
        logTime(`处理创作者身份组申请时出错: ${error}`, true);
        await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
    }
}

// 初始化功能
let initialized = false;

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // 首次执行时初始化
        if (!initialized && interaction.client.isReady()) {
            await createApplicationMessage(interaction.client);
            initialized = true;
        }

        // 处理交互
        if (interaction.isButton()) {
            await handleButtonInteraction(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction);
        }
    }
}; 