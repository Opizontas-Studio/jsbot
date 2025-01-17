import { 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    EmbedBuilder,
    ChannelType,
    Collection 
} from 'discord.js';
import { logTime } from './helper.js';
import { globalRequestQueue, globalRateLimiter } from './concurrency.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 创建冷却时间集合
const cooldowns = new Collection();

/**
 * 处理创建申请消息
 * @param {Client} client - Discord客户端
 */
export const createApplicationMessage = async (client) => {
    // 读取消息ID配置
    const messageIdsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'messageIds.json');
    let messageIds;
    try {
        messageIds = JSON.parse(readFileSync(messageIdsPath, 'utf8'));
        if (!messageIds.roleApplicationMessages) {
            messageIds.roleApplicationMessages = {};
        }
    } catch (error) {
        logTime(`读取消息ID配置失败: ${error}`, true);
        return;
    }

    // 为每个配置了身份组申请功能的服务器检查/创建申请消息
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        // 检查功能是否启用
        if (!guildConfig.roleApplication?.enabled) {
            // 如果功能被禁用，删除旧的申请消息（如果存在）
            const oldMessageId = messageIds.roleApplicationMessages[guildId];
            if (oldMessageId) {
                try {
                    await globalRequestQueue.add(async () => {
                        const channel = await client.channels.fetch(guildConfig.roleApplication.creatorRoleThreadId);
                        if (channel) {
                            const oldMessage = await channel.messages.fetch(oldMessageId);
                            if (oldMessage) {
                                await oldMessage.delete();
                                logTime(`已删除服务器 ${guildId} 的旧申请消息（功能已禁用）`);
                            }
                        }
                    }, 1);
                    // 清除消息ID记录
                    delete messageIds.roleApplicationMessages[guildId];
                    writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
                } catch (error) {
                    logTime(`删除旧申请消息失败: ${error}`, true);
                }
            }
            continue;
        }

        // 检查必要的配置是否存在
        if (!guildConfig.roleApplication?.creatorRoleThreadId || !guildConfig.roleApplication?.creatorRoleId) {
            logTime(`服务器 ${guildId} 的身份组申请配置不完整`, true);
            continue;
        }

        try {
            await globalRequestQueue.add(async () => {
                const channel = await client.channels.fetch(guildConfig.roleApplication.creatorRoleThreadId);
                if (!channel) return;

                // 检查是否已存在消息
                const existingMessageId = messageIds.roleApplicationMessages[guildId];
                if (existingMessageId) {
                    try {
                        await channel.messages.fetch(existingMessageId);
                        logTime(`服务器 ${guildId} 的申请消息已存在，无需重新创建`);
                        return;
                    } catch (error) {
                        logTime(`服务器 ${guildId} 的现有申请消息已失效，将创建新消息`, true);
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
                writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
                
                logTime(`已在服务器 ${guildId} 创建新的身份组申请消息`);
            }, 1);
        } catch (error) {
            logTime(`在服务器 ${guildId} 创建身份组申请消息时出错: ${error}`, true);
        }
    }
};

/**
 * 处理按钮交互
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export const handleButtonInteraction = async (interaction) => {
    if (interaction.customId !== 'apply_creator_role') return;

    // 检查功能是否启用
    const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
    if (!guildConfig?.roleApplication?.enabled) {
        await interaction.reply({
            content: '❌ 此服务器未启用身份组申请功能',
            flags: ['Ephemeral']
        });
        return;
    }

    // 检查用户是否已有创作者身份组
    const member = await interaction.guild.members.fetch(interaction.user.id);
    
    if (member.roles.cache.has(guildConfig.roleApplication.creatorRoleId)) {
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
};

/**
 * 处理模态框提交
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export const handleModalSubmit = async (interaction) => {
    if (interaction.customId !== 'creator_role_modal') return;

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
        const threadLink = interaction.fields.getTextInputValue('thread_link');
        const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);

        if (!matches) {
            await interaction.editReply('❌ 无效的帖子链接格式');
            return;
        }

        const [, linkGuildId, threadId] = matches;
        const currentGuildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

        // 检查当前服务器是否启用功能
        if (!currentGuildConfig?.roleApplication?.enabled) {
            await interaction.editReply('❌ 此服务器未启用身份组申请功能');
            return;
        }

        if (!currentGuildConfig?.roleApplication?.creatorRoleId) {
            await interaction.editReply('❌ 服务器配置错误');
            return;
        }

        // 检查链接所属服务器是否在配置中
        const linkGuildConfig = interaction.client.guildManager.getGuildConfig(linkGuildId);
        if (!linkGuildConfig) {
            await interaction.editReply('❌ 提供的帖子不在允许的服务器中');
            return;
        }

        await globalRequestQueue.add(async () => {
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
            const moderationChannel = await interaction.client.channels.fetch(currentGuildConfig.roleApplication.logThreadId);
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
                    },
                    {
                        name: '作品所在服务器',
                        value: thread.guild.name,
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
                const member = await interaction.guild.members.fetch(interaction.user.id);
                await member.roles.add(currentGuildConfig.roleApplication.creatorRoleId);
                await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');
                
                // 只有通过审核才发送日志
                if (moderationChannel) {
                    await moderationChannel.send({ embeds: [auditEmbed] });
                }
                
                logTime(`用户 ${interaction.user.tag} 获得了创作者身份组`);
            } else {
                await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
            }
        }, 2); // 使用较高优先级，因为这是用户交互

    } catch (error) {
        logTime(`处理创作者身份组申请时出错: ${error}`, true);
        await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
    }
}; 