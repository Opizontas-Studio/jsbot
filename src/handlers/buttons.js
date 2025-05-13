import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Collection,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import CourtService from '../services/courtService.js';
import { exitSenatorRole, syncMemberRoles } from '../services/roleApplication.js';
import { VoteService } from '../services/voteService.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { checkAppealEligibility, checkPunishmentStatus } from '../utils/punishmentHelper.js';
import { globalTaskScheduler } from './scheduler.js';

// 创建冷却时间集合
const cooldowns = new Collection();

/**
 * 检查并设置冷却时间
 * @param {string} type - 操作类型
 * @param {string} userId - 用户ID
 * @param {number} [duration=10000] - 冷却时间（毫秒）
 * @returns {number|null} 剩余冷却时间（秒），无冷却返回null
 */
export function checkCooldown(type, userId, duration = 10000) {
    const now = Date.now();
    const cooldownKey = `${type}:${userId}`;
    const cooldownTime = cooldowns.get(cooldownKey);

    if (cooldownTime && now < cooldownTime) {
        return Math.ceil((cooldownTime - now) / 1000);
    }

    // 设置冷却时间
    cooldowns.set(cooldownKey, now + duration);
    setTimeout(() => cooldowns.delete(cooldownKey), duration);
    return null;
}

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
 * @param {number} [options.timeout=120000] - 超时时间（毫秒）
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
    timeout = 120000,
}) {
    // 创建确认按钮
    const confirmButton = new ButtonBuilder().setCustomId(customId).setLabel(buttonLabel).setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    // 添加默认的页脚文本
    if (!embed.footer) {
        embed.footer = { text: '此确认按钮将在2分钟后失效' };
    }

    // 发送确认消息
    const response = await interaction.editReply({
        embeds: [embed],
        components: [row],
    });

    // 在后台处理按钮交互，不阻塞主流程
    waitForConfirmation(response, interaction, customId, onConfirm, onTimeout, onError, timeout).catch(error => {
        logTime(`确认按钮等待处理出错: ${error.message}`, true);
    });
}

/**
 * 等待用户确认交互
 * @private
 */
async function waitForConfirmation(response, interaction, customId, onConfirm, onTimeout, onError, timeout) {
    try {
        const confirmation = await response.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id,
            time: timeout,
        });

        if (confirmation.customId === customId) {
            await onConfirm(confirmation);
        }
    } catch (error) {
        if (onError) {
            await onError(error);
        } else if (
            error.code === 'InteractionCollectorError' ||
            error.message?.includes('Collector received no interactions before ending with reason: time')
        ) {
            // 处理超时等基础交互错误
            logTime(`按钮确认超时: ${customId}`);
            if (onTimeout) {
                await onTimeout(interaction);
            } else {
                // 默认的超时处理
                await interaction.editReply({
                    embeds: [
                        {
                            color: 0x808080,
                            title: '❌ 确认已超时',
                            description: '操作已取消。如需继续请重新执行命令。',
                        },
                    ],
                    components: [],
                });
            }
        } else {
            // 其他错误记录日志
            logTime(`确认按钮处理错误: ${error.message}`, true);
        }
    }
}

/**
 * 移除上诉按钮辅助函数
 * @param {User} user - Discord用户对象
 * @param {string} messageId - 消息ID
 */
async function removeAppealButton(user, messageId) {
    if (!messageId) return;

    try {
        const dmChannel = await user.createDM();
        if (dmChannel) {
            const originalMessage = await dmChannel.messages.fetch(messageId).catch(() => null);
            if (originalMessage) {
                await originalMessage.edit({ components: [] });
                logTime(`已移除上诉按钮: ${messageId}`);
            }
        }
    } catch (error) {
        logTime(`移除上诉按钮失败: ${error.message}`, true);
    }
}

/**
 * 查找对应的按钮配置
 * @param {string} customId - 按钮的自定义ID
 * @returns {Object|null} - 按钮配置对象或null
 */
function findButtonConfig(customId) {
    // 1. 首先检查完整customId是否直接匹配
    if (BUTTON_CONFIG.deferButtons[customId]) {
        return {
            needDefer: true,
            handler: BUTTON_CONFIG.deferButtons[customId].handler,
        };
    }

    if (BUTTON_CONFIG.modalButtons[customId]) {
        return {
            needDefer: false,
            handler: BUTTON_CONFIG.modalButtons[customId],
        };
    }

    // 2. 检查前缀匹配（针对带有额外参数的按钮ID）
    const buttonPrefix = customId.split('_').slice(0, 2).join('_');

    if (BUTTON_CONFIG.deferButtons[buttonPrefix]) {
        return {
            needDefer: true,
            handler: BUTTON_CONFIG.deferButtons[buttonPrefix].handler,
        };
    }

    if (BUTTON_CONFIG.modalButtons[buttonPrefix]) {
        return {
            needDefer: false,
            handler: BUTTON_CONFIG.modalButtons[buttonPrefix],
        };
    }

    // 3. 处理特殊前缀匹配（如appeal_等需要部分匹配的情况）
    for (const [prefix, handler] of Object.entries(BUTTON_CONFIG.modalButtons)) {
        if (customId !== prefix && customId.startsWith(prefix)) {
            return {
                needDefer: false,
                handler: handler,
            };
        }
    }

    return null;
}

/**
 * 按钮处理器映射
 * 每个处理器函数接收一个 ButtonInteraction 参数
 */
export const buttonHandlers = {
    // 身份组申请按钮处理器
    apply_creator_role: async interaction => {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('roleapply', interaction.user.id);
        if (cooldownLeft) {
            await interaction.reply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次申请`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig || !guildConfig.roleApplication || !guildConfig.roleApplication.creatorRoleId) {
            await interaction.reply({
                content: '❌ 服务器未正确配置创作者身份组',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查用户是否已有创作者身份组
        const member = await interaction.guild.members.fetch(interaction.user.id);

        if (member.roles.cache.has(guildConfig.roleApplication.creatorRoleId)) {
            await interaction.reply({
                content: '❌ 您已经拥有创作者身份组',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 显示申请表单
        const modal = new ModalBuilder().setCustomId('creator_role_modal').setTitle('创作者身份组申请');

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

    // 议员身份组自助退出按钮处理器
    exit_senator_role: async interaction => {
        await exitSenatorRole(interaction, { handleConfirmationButton });
    },

    // 翻页按钮处理器
    page_prev: async interaction => {
        const currentPage = parseInt(interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/)[1]);
        const totalPages = parseInt(interaction.message.embeds[0].footer.text.match(/共 (\d+) 页/)[1]);
        const pages = interaction.message.client.pageCache.get(interaction.message.id);

        if (!pages) {
            await interaction.reply({
                content: '❌ 页面数据已过期，请重新执行查询命令',
                flags: ['Ephemeral'],
            });
            return;
        }

        const newPage = currentPage > 1 ? currentPage - 1 : totalPages;
        await interaction.update(pages[newPage - 1]);
    },

    page_next: async interaction => {
        const currentPage = parseInt(interaction.message.embeds[0].footer.text.match(/第 (\d+) 页/)[1]);
        const totalPages = parseInt(interaction.message.embeds[0].footer.text.match(/共 (\d+) 页/)[1]);
        const pages = interaction.message.client.pageCache.get(interaction.message.id);

        if (!pages) {
            await interaction.reply({
                content: '❌ 页面数据已过期，请重新执行查询命令',
                flags: ['Ephemeral'],
            });
            return;
        }

        const newPage = currentPage < totalPages ? currentPage + 1 : 1;
        await interaction.update(pages[newPage - 1]);
    },

    // 议事区支持按钮处理器
    support_mute: async interaction => {
        await CourtService.handleSupport(interaction, 'mute');
    },

    support_ban: async interaction => {
        await CourtService.handleSupport(interaction, 'ban');
    },

    support_appeal: async interaction => {
        await CourtService.handleSupport(interaction, 'appeal');
    },

    support_debate: async interaction => {
        await CourtService.handleSupport(interaction, 'debate');
    },

    // 投票按钮处理器
    vote_red: async interaction => {
        await VoteService.handleVoteButton(interaction, 'red');
    },

    vote_blue: async interaction => {
        await VoteService.handleVoteButton(interaction, 'blue');
    },

    // 身份组同步按钮处理器
    sync_roles: async interaction => {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('role_sync', interaction.user.id, 60000); // 1分钟冷却
        if (cooldownLeft) {
            return await interaction.editReply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次同步`,
            });
        }

        try {
            // 同步身份组
            const { syncedRoles } = await syncMemberRoles(interaction.member);

            // 构建回复消息
            let replyContent;
            if (syncedRoles.length > 0) {
                replyContent = [
                    '✅ 身份组同步完成',
                    '',
                    '**同步成功的身份组：**',
                    ...syncedRoles.map(role => `• ${role.name} (从 ${role.sourceServer} 同步到 ${role.targetServer})`),
                ].join('\n');
            } else {
                replyContent = ['✅ 没有需要同步的身份组'].join('\n');
            }

            // 回复用户
            await interaction.editReply({
                content: replyContent,
            });
        } catch (error) {
            await interaction.editReply({
                content: '❌ 同步身份组时出错，请稍后重试',
            });
            logTime(`同步身份组失败: ${error.message}`, true);
        }
    },

    // 提交议事按钮处理器
    start_debate: async interaction => {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('start_debate', interaction.user.id);
        if (cooldownLeft) {
            await interaction.reply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次提交`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查议事系统是否启用
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.courtSystem?.enabled) {
            await interaction.reply({
                content: '❌ 此服务器未启用议事系统',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为议员
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(guildConfig.roleApplication?.senatorRoleId)) {
            await interaction.reply({
                content: '❌ 只有议员可以提交议案',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查用户是否已有活跃的流程
        try {
            const activeProcesses = await ProcessModel.getUserProcesses(interaction.user.id, false);

            // 检查是否有任何活跃流程
            if (activeProcesses && activeProcesses.length > 0) {
                await interaction.reply({
                    content: '❌ 你已经有正在进行的议事流程，同时只能提交一个议案申请',
                    flags: ['Ephemeral'],
                });
                return;
            }
        } catch (error) {
            logTime(`检查用户活跃流程失败: ${error.message}`, true);
            await interaction.reply({
                content: '❌ 检查流程状态时出错，请稍后重试',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 创建模态框
        const modal = new ModalBuilder().setCustomId('submit_debate_modal').setTitle('提交议事');

        // 标题输入
        const titleInput = new TextInputBuilder()
            .setCustomId('debate_title')
            .setLabel('议案标题（最多30字）')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('格式形如：议案：对于商业化的进一步对策')
            .setMaxLength(30)
            .setRequired(true);

        // 原因输入
        const reasonInput = new TextInputBuilder()
            .setCustomId('debate_reason')
            .setLabel('提案原因（20到400字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明提出此议案的原因')
            .setMinLength(20)
            .setMaxLength(400)
            .setRequired(true);

        // 动议输入
        const motionInput = new TextInputBuilder()
            .setCustomId('debate_motion')
            .setLabel('议案动议（20到400字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明您的动议内容，具体的目标是什么')
            .setMinLength(20)
            .setMaxLength(400)
            .setRequired(true);

        // 执行方式输入
        const implementationInput = new TextInputBuilder()
            .setCustomId('debate_implementation')
            .setLabel('执行方案（30到1000字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明如何执行此动议，包括执行人是谁，执行方式，如何考核监督等')
            .setMinLength(30)
            .setMaxLength(1000)
            .setRequired(true);

        // 投票时间输入
        const voteTimeInput = new TextInputBuilder()
            .setCustomId('debate_vote_time')
            .setLabel('投票时间（不超过7天）')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('填写格式形如：1天')
            .setMaxLength(50)
            .setRequired(true);

        // 将输入添加到模态框
        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(reasonInput),
            new ActionRowBuilder().addComponents(motionInput),
            new ActionRowBuilder().addComponents(implementationInput),
            new ActionRowBuilder().addComponents(voteTimeInput),
        );

        // 显示模态框
        await interaction.showModal(modal);
    },

    // 撤销流程按钮处理器
    revoke_process: async interaction => {
        try {
            // 获取议事消息
            const message = interaction.message;

            // 解析按钮ID获取提交者ID和流程类型
            const [, , submitterId, processType] = interaction.customId.split('_');

            // 检查是否是提交者本人
            if (interaction.user.id !== submitterId) {
                await interaction.editReply({
                    content: '❌ 只有申请人本人可以撤销申请',
                });
                return;
            }

            // 获取流程记录
            const process = await ProcessModel.getProcessByMessageId(message.id);
            if (!process) {
                await interaction.editReply({
                    content: '❌ 找不到相关流程记录',
                });
                return;
            }

            // 检查流程状态
            if (process.status === 'completed' || process.status === 'cancelled') {
                await interaction.editReply({
                    content: '❌ 该流程已结束，无法撤销',
                });
                return;
            }

            // 尝试删除流程消息
            try {
                await message.delete();
                logTime(`流程消息已被删除: ${message.id}, 类型: ${process.type}`);
            } catch (error) {
                logTime(`删除流程消息失败: ${error.message}`, true);
                // 继续执行，不影响主流程
            }

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason: `由申请人 ${interaction.user.tag} 撤销`,
            });

            // 取消计时器
            await globalTaskScheduler.getProcessScheduler().cancelProcess(process.id);

            // 记录操作日志
            logTime(`${process.type} 流程 ${process.id} 已被申请人 ${interaction.user.tag} 撤销`);

            await interaction.editReply({
                content: '✅ 申请已成功撤销，相关消息已删除',
            });
        } catch (error) {
            await handleInteractionError(interaction, error, 'revoke_process');
        }
    },

    // 撤回上诉按钮处理器
    revoke_appeal: async interaction => {
        try {
            // 解析按钮ID获取提交者ID、流程ID和原始消息ID
            const [, , submitterId, processId, originalMessageId] = interaction.customId.split('_');

            // 获取流程记录
            const process = await ProcessModel.getProcessById(parseInt(processId));
            if (!process) {
                await interaction.editReply({
                    content: '❌ 找不到相关上诉流程记录',
                });
                return;
            }

            // 检查流程状态
            if (process.status === 'completed' || process.status === 'cancelled') {
                await interaction.editReply({
                    content: '❌ 该上诉已结束，无法撤销',
                });

                // 更新原始消息，移除撤回按钮
                await removeAppealButton(interaction.user, originalMessageId);
                return;
            }

            // 尝试删除议事区消息
            if (process.messageId) {
                const mainGuildConfig = interaction.client.guildManager
                    .getGuildIds()
                    .map(id => interaction.client.guildManager.getGuildConfig(id))
                    .find(config => config?.serverType === 'Main server');

                const courtChannelId = mainGuildConfig?.courtSystem?.courtChannelId;

                if (courtChannelId) {
                    try {
                        const courtChannel = await interaction.client.channels.fetch(courtChannelId);
                        if (courtChannel) {
                            const courtMessage = await courtChannel.messages.fetch(process.messageId).catch(() => null);
                            if (courtMessage) {
                                await courtMessage.delete();
                            }
                        }
                    } catch (error) {
                        logTime(`删除上诉议事消息失败: ${error.message}`, true);
                        // 继续执行，不影响主流程
                    }
                }
            }

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason: `由申请人 ${interaction.user.tag} 撤销上诉`,
            });

            // 取消计时器
            await globalTaskScheduler.getProcessScheduler().cancelProcess(process.id);

            // 更新原始消息，移除撤回按钮
            await removeAppealButton(interaction.user, originalMessageId);

            // 记录操作日志
            logTime(`上诉流程 ${process.id} 已被申请人 ${interaction.user.tag} 撤销`);

            await interaction.editReply({
                content: '✅ 上诉申请已成功撤销',
            });
        } catch (error) {
            await handleInteractionError(interaction, error, 'revoke_appeal');
        }
    },

    // 上诉按钮处理器
    appeal: async (interaction, punishmentId) => {
        try {
            // 检查冷却时间
            const cooldownLeft = checkCooldown('appeal', interaction.user.id);
            if (cooldownLeft) {
                await interaction.reply({
                    content: `❌ 请等待 ${cooldownLeft} 秒后再次申请`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取处罚记录
            const punishment = await PunishmentModel.getPunishmentById(parseInt(punishmentId));

            // 检查处罚状态
            const { isValid, error: statusError } = checkPunishmentStatus(punishment);
            if (!isValid) {
                await removeAppealButton(interaction.user, interaction.message.id);
                await interaction.reply({
                    content: `❌ ${statusError}`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查上诉资格
            const { isEligible, error: eligibilityError } = await checkAppealEligibility(interaction.user.id);
            if (!isEligible) {
                await removeAppealButton(interaction.user, interaction.message.id);
                await interaction.reply({
                    content: `❌ ${eligibilityError}`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 调试日志
            logTime(`用户申请上诉，处罚记录状态: ID=${punishmentId}, status=${punishment.status}`);

            // 创建上诉表单
            const modal = new ModalBuilder()
                .setCustomId(`appeal_modal_${punishmentId}_${interaction.message.id}`)
                .setTitle('提交上诉申请');

            const appealContentInput = new TextInputBuilder()
                .setCustomId('appeal_content')
                .setLabel('请详细说明你的上诉理由')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(
                    '请详细描述你的上诉理由，包括：\n1. 为什么你认为处罚不合理\n2. 为什么你认为议员应该支持你上诉\n3. 其他支持你上诉的理由\n如您有更多信息或图片需要提交，请使用托管在网络上的文档链接传达。',
                )
                .setMinLength(10)
                .setMaxLength(1000)
                .setRequired(true);

            const firstActionRow = new ActionRowBuilder().addComponents(appealContentInput);
            modal.addComponents(firstActionRow);

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'appeal_button');
        }
    },

    // 投稿AI新闻按钮处理器
    submit_news: async interaction => {
        try {
            // 检查冷却时间
            const cooldownLeft = checkCooldown('news_submission', interaction.user.id, 30000); // 30秒冷却
            if (cooldownLeft) {
                await interaction.reply({
                    content: `❌ 请等待 ${cooldownLeft} 秒后再次投稿`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 创建投稿表单
            const modal = new ModalBuilder().setCustomId('news_submission_modal').setTitle('AI新闻投稿');

            const titleInput = new TextInputBuilder()
                .setCustomId('news_title')
                .setLabel('新闻标题')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('请输入简短明了的新闻标题')
                .setMinLength(5)
                .setMaxLength(100)
                .setRequired(true);

            const contentInput = new TextInputBuilder()
                .setCustomId('news_content')
                .setLabel('新闻内容')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('请详细描述新闻内容，可以包含链接')
                .setMinLength(10)
                .setMaxLength(1500)
                .setRequired(true);

            const firstActionRow = new ActionRowBuilder().addComponents(titleInput);
            const secondActionRow = new ActionRowBuilder().addComponents(contentInput);
            modal.addComponents(firstActionRow, secondActionRow);

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'submit_news_button');
        }
    },

    // 投稿社区意见按钮处理器
    submit_opinion: async interaction => {
        try {
            // 检查冷却时间
            const cooldownLeft = checkCooldown('opinion_submission', interaction.user.id, 30000); // 30秒冷却
            if (cooldownLeft) {
                await interaction.reply({
                    content: `❌ 请等待 ${cooldownLeft} 秒后再次提交`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 创建意见表单
            const modal = new ModalBuilder().setCustomId('opinion_submission_modal').setTitle('社区意见投稿');

            const titleInput = new TextInputBuilder()
                .setCustomId('opinion_title')
                .setLabel('意见标题')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('请简短描述您的意见或建议主题')
                .setMinLength(5)
                .setMaxLength(100)
                .setRequired(true);

            const contentInput = new TextInputBuilder()
                .setCustomId('opinion_content')
                .setLabel('详细内容')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('请详细描述您的意见或建议')
                .setMinLength(10)
                .setMaxLength(1500)
                .setRequired(true);

            const firstActionRow = new ActionRowBuilder().addComponents(titleInput);
            const secondActionRow = new ActionRowBuilder().addComponents(contentInput);
            modal.addComponents(firstActionRow, secondActionRow);

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'submit_opinion_button');
        }
    },
};

// 按钮处理配置对象
const BUTTON_CONFIG = {
    // 需要defer的按钮
    deferButtons: {
        exit_senator_role: { handler: buttonHandlers.exit_senator_role },
        support_mute: { handler: interaction => CourtService.handleSupport(interaction, 'mute') },
        support_ban: { handler: interaction => CourtService.handleSupport(interaction, 'ban') },
        support_appeal: { handler: interaction => CourtService.handleSupport(interaction, 'appeal') },
        support_debate: { handler: interaction => CourtService.handleSupport(interaction, 'debate') },
        vote_red: { handler: interaction => VoteService.handleVoteButton(interaction, 'red') },
        vote_blue: { handler: interaction => VoteService.handleVoteButton(interaction, 'blue') },
        sync_roles: { handler: buttonHandlers.sync_roles },
        revoke_process: { handler: buttonHandlers.revoke_process },
        revoke_appeal: { handler: buttonHandlers.revoke_appeal },
    },

    // 不需要defer的按钮
    modalButtons: {
        appeal_: interaction => {
            const punishmentId = interaction.customId.split('_')[1];
            return buttonHandlers.appeal(interaction, punishmentId);
        },
        apply_creator_role: buttonHandlers.apply_creator_role,
        start_debate: buttonHandlers.start_debate,
        page_prev: buttonHandlers.page_prev,
        page_next: buttonHandlers.page_next,
        submit_news: buttonHandlers.submit_news,
        submit_opinion: buttonHandlers.submit_opinion,
    },
};

/**
 * 统一的按钮交互处理函数
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export async function handleButton(interaction) {
    try {
        // 1. 首先处理确认类按钮
        if (interaction.customId.startsWith('confirm_')) {
            return;
        }

        // 2. 查找匹配的按钮处理配置
        const buttonConfig = findButtonConfig(interaction.customId);

        if (!buttonConfig) {
            logTime(`未找到按钮处理器: ${interaction.customId}`, true);
            return;
        }

        // 3. 根据配置决定是否需要defer
        if (buttonConfig.needDefer) {
            await interaction.deferReply({ flags: ['Ephemeral'] });
        }

        // 4. 执行对应处理器
        await buttonConfig.handler(interaction);
    } catch (error) {
        // 如果是已知的交互错误，不再重复处理
        if (error.name === 'InteractionAlreadyReplied') {
            logTime(`按钮交互已回复: ${interaction.customId}`, true);
            return;
        }

        await handleInteractionError(interaction, error, 'button');
    }
}
