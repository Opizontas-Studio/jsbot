import { logTime } from '../utils/logger.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, Collection } from 'discord.js';
import { DiscordAPIError } from '@discordjs/rest';
import { handleDiscordError } from '../utils/helper.js';

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
};

/**
 * 统一的按钮交互处理函数
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export async function handleButton(interaction) {
    // 如果是确认按钮（以confirm_开头），直接返回
    if (interaction.customId.startsWith('confirm_')) {
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