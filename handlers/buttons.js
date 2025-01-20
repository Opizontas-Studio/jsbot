import { logTime } from '../utils/logger.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, Collection } from 'discord.js';
import { DiscordAPIError } from '@discordjs/rest';
import { handleDiscordError } from '../utils/helper.js';
import { ProcessModel } from '../db/models/process.js';

// 创建冷却时间集合
const cooldowns = new Collection();

/**
 * 创建并处理确认按钮
 * @param {Object} options - 配置选项
 * @param {BaseInteraction} options.interaction - Discord交互对象
 * @param {Object} options.embed - 确认消息的嵌入配置
 * @param {string} options.customId - 按钮的自定义ID
 * @param {string} options.buttonLabel - 按钮文本
 * @param {Function} options.onConfirm - 确认后的回调函数
 * @param {Function} [options.onTimeout] - 超时后的回调函数
 * @param {Function} [options.onError] - 错误处理回调函数
 * @param {number} [options.timeout=300000] - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
export async function handleConfirmationButton({
    interaction,
    embed,
    customId,
    buttonLabel,
    onConfirm,
    onTimeout,
    onError,
    timeout = 300000
}) {
    // 创建确认按钮
    const confirmButton = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder()
        .addComponents(confirmButton);

    // 添加默认的页脚文本
    if (!embed.footer) {
        embed.footer = { text: '此确认按钮将在5分钟后失效' };
    }

    // 发送确认消息
    const response = await interaction.editReply({
        embeds: [embed],
        components: [row]
    });

    try {
        const confirmation = await response.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id,
            time: timeout
        });

        if (confirmation.customId === customId) {
            await onConfirm(confirmation);
        }
    } catch (error) {
        if (error.code === 'InteractionCollectorError') {
            if (onTimeout) {
                await onTimeout(interaction);
            } else {
                // 默认的超时处理
                await interaction.editReply({
                    embeds: [{
                        color: 0x808080,
                        title: '❌ 确认已超时',
                        description: '操作已取消。如需继续请重新执行命令。'
                    }],
                    components: []
                });
            }
        } else if (onError) {
            await onError(error);
        } else {
            throw error;
        }
    }
}

/**
 * 按钮处理器映射
 * 每个处理器函数接收一个 ButtonInteraction 参数
 */
export const buttonHandlers = {
    // 身份组申请按钮处理器
    'apply_creator_role': async (interaction) => {
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
    },

    // 处罚系统按钮处理器将在这里添加
    // 'punish_appeal': async (interaction) => {...},
    // 'punish_vote': async (interaction) => {...},

    // 翻页按钮处理器
    'page_prev': async (interaction) => {
        const currentPage = parseInt(interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/)[1]);
        const totalPages = parseInt(interaction.message.embeds[0].footer.text.match(/共 (\d+) 页/)[1]);
        const pages = interaction.message.client.pageCache.get(interaction.message.id);
        
        if (!pages) {
            await interaction.reply({
                content: '❌ 页面数据已过期，请重新执行查询命令',
                flags: ['Ephemeral']
            });
            return;
        }

        const newPage = currentPage > 1 ? currentPage - 1 : totalPages;
        await interaction.update(pages[newPage - 1]);
    },

    'page_next': async (interaction) => {
        const currentPage = parseInt(interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/)[1]);
        const totalPages = parseInt(interaction.message.embeds[0].footer.text.match(/共 (\d+) 页/)[1]);
        const pages = interaction.message.client.pageCache.get(interaction.message.id);
        
        if (!pages) {
            await interaction.reply({
                content: '❌ 页面数据已过期，请重新执行查询命令',
                flags: ['Ephemeral']
            });
            return;
        }

        const newPage = currentPage < totalPages ? currentPage + 1 : 1;
        await interaction.update(pages[newPage - 1]);
    },

    // 议事区支持按钮处理器
    'support_mute': async (interaction) => {
        await handleCourtSupport(interaction, 'mute');
    },

    'support_ban': async (interaction) => {
        await handleCourtSupport(interaction, 'ban');
    },
};

/**
 * 处理议事区支持按钮
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 * @param {string} type - 处罚类型 ('mute' | 'ban')
 */
async function handleCourtSupport(interaction, type) {
    // 检查议事系统是否启用
    const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
    if (!guildConfig?.courtSystem?.enabled) {
        await interaction.reply({
            content: '❌ 此服务器未启用议事系统',
            flags: ['Ephemeral']
        });
        return;
    }

    // 检查是否为议员
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.roles.cache.has(guildConfig.courtSystem.senatorRoleId)) {
        await interaction.reply({
            content: '❌ 只有议员可以参与议事投票',
            flags: ['Ephemeral']
        });
        return;
    }

    // 解析按钮ID获取目标用户ID和原始交互ID
    const [, , targetId, originalInteractionId] = interaction.customId.split('_');

    // 检查冷却时间
    const now = Date.now();
    const cooldownKey = `court_support:${interaction.user.id}:${targetId}`;
    const cooldownTime = cooldowns.get(cooldownKey);

    if (cooldownTime && now < cooldownTime) {
        const timeLeft = Math.ceil((cooldownTime - now) / 1000);
        await interaction.reply({
            content: `❌ 请等待 ${timeLeft} 秒后再次投票`,
            flags: ['Ephemeral']
        });
        return;
    }

    try {
        // 获取或创建议事流程
        let process = await ProcessModel.getProcessByMessageId(interaction.message.id);
        
        if (!process) {
            // 如果流程不存在，创建新的流程
            process = await ProcessModel.createCourtProcess({
                type: `court_${type}`,
                targetId,
                executorId: originalInteractionId,
                messageId: interaction.message.id,
                expireAt: Date.now() + guildConfig.courtSystem.appealDuration,
                details: {
                    embed: interaction.message.embeds[0]
                }
            });
        }

        // 添加支持者并可能创建辩诉帖子
        const { process: updatedProcess, debateThread } = await ProcessModel.addSupporter(
            interaction.message.id,
            interaction.user.id,
            guildConfig,
            interaction.client
        );

        // 设置冷却时间
        cooldowns.set(cooldownKey, now + 60000);
        setTimeout(() => cooldowns.delete(cooldownKey), 60000);

        // 更新消息
        const embed = interaction.message.embeds[0];
        const updatedFields = [...embed.fields];
        const supportCountField = embed.fields.find(field => field.name === '当前支持');
        const supportCount = JSON.parse(updatedProcess.supporters).length;
        
        if (supportCountField) {
            const fieldIndex = updatedFields.findIndex(field => field.name === '当前支持');
            updatedFields[fieldIndex] = {
                name: '当前支持',
                value: `${supportCount} 位议员`,
                inline: true
            };
        } else {
            updatedFields.push({
                name: '当前支持',
                value: `${supportCount} 位议员`,
                inline: true
            });
        }

        await interaction.message.edit({
            embeds: [{
                ...embed,
                fields: updatedFields
            }]
        });

        // 发送确认消息
        let replyContent = `✅ 你已支持此${type === 'mute' ? '禁言' : '永封'}处罚申请，当前共有 ${supportCount} 位议员支持`;
        
        // 如果创建了辩诉帖子，添加链接
        if (debateThread) {
            replyContent += `\n📢 已达到所需支持人数，辩诉帖子已创建：${debateThread.url}`;
        }

        await interaction.reply({
            content: replyContent,
            flags: ['Ephemeral']
        });

    } catch (error) {
        logTime(`处理议事支持失败: ${error.message}`, true);
        await interaction.reply({
            content: '❌ 处理支持请求时出错，请稍后重试',
            flags: ['Ephemeral']
        });
    }
}

/**
 * 统一的按钮交互处理函数
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export async function handleButton(interaction) {
    // 如果是确认按钮（以confirm_开头），直接返回
    if (interaction.customId.startsWith('confirm_')) {
        return;
    }

    // 处理支持按钮
    if (interaction.customId.startsWith('support_')) {
        const [action, type, ...rest] = interaction.customId.split('_');
        const handler = buttonHandlers[`${action}_${type}`];
        if (handler) {
            await handler(interaction);
            return;
        }
    }

    // 处理按钮交互
    if (interaction.customId.startsWith('appeal_')) {
        const punishmentId = interaction.customId.split('_')[1];
        await handleAppealButton(interaction, punishmentId);
        return;
    }

    const handler = buttonHandlers[interaction.customId];
    if (!handler) {
        logTime(`未找到按钮处理器: ${interaction.customId}`, true);
        return;
    }

    try {
        await handler(interaction);
    } catch (error) {
        const errorMessage = error instanceof DiscordAPIError ? 
            handleDiscordError(error) : 
            '处理请求时出现错误，请稍后重试。';
            
        logTime(`按钮处理出错 [${interaction.customId}]: ${errorMessage}`, true);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: `❌ ${errorMessage}`,
                flags: ['Ephemeral']
            });
        }
    }
} 