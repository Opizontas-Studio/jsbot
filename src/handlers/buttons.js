import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Collection,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { dbManager } from '../db/dbManager.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import CourtService from '../services/courtService.js';
import { VoteService } from '../services/voteService.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { checkAppealEligibility, checkPunishmentStatus } from '../utils/punishmentHelper.js';

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
    timeout = 300000,
}) {
    // 创建确认按钮
    const confirmButton = new ButtonBuilder().setCustomId(customId).setLabel(buttonLabel).setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    // 添加默认的页脚文本
    if (!embed.footer) {
        embed.footer = { text: '此确认按钮将在5分钟后失效' };
    }

    // 发送确认消息
    const response = await interaction.editReply({
        embeds: [embed],
        components: [row],
    });

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
        } else if (error.code === 'InteractionCollectorError') {
            // 处理超时等基础交互错误
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
            // 其他错误向上抛出，让调用者处理
            throw error;
        }
    }
}

/**
 * 检查并设置冷却时间
 * @param {string} type - 操作类型
 * @param {string} userId - 用户ID
 * @param {number} [duration=30000] - 冷却时间（毫秒）
 * @returns {number|null} 剩余冷却时间（秒），无冷却返回null
 */
function checkCooldown(type, userId, duration = 30000) {
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

        // 检查功能是否启用
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.roleApplication?.enabled) {
            await interaction.reply({
                content: '❌ 此服务器未启用身份组申请功能',
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
        await handleCourtSupport(interaction, 'mute');
    },

    support_ban: async interaction => {
        await handleCourtSupport(interaction, 'ban');
    },

    support_appeal: async interaction => {
        await handleCourtSupport(interaction, 'appeal');
    },

    support_debate: async interaction => {
        await handleCourtSupport(interaction, 'debate');
    },

    // 投票按钮处理器
    vote_red: async interaction => {
        await handleVoteButton(interaction, 'red');
    },

    vote_blue: async interaction => {
        await handleVoteButton(interaction, 'blue');
    },
};

/**
 * 处理议事区支持按钮
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 * @param {string} type - 议事类型 ('mute' | 'ban' | 'appeal' | 'debate')
 */
async function handleCourtSupport(interaction, type) {
    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('court_support', interaction.user.id);
        if (cooldownLeft) {
            return await interaction.editReply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次投票`,
            });
        }

        // 检查议事系统是否启用
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.courtSystem?.enabled) {
            return await interaction.editReply({
                content: '❌ 此服务器未启用议事系统',
            });
        }

        // 检查是否为议员
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(guildConfig.courtSystem.senatorRoleId)) {
            return await interaction.editReply({
                content: '❌ 只有议员可以参与议事投票',
            });
        }

        // 解析按钮ID获取目标用户ID
        const [, , targetId] = interaction.customId.split('_');

        // 使用事务包装数据库操作
        const result = await dbManager.transaction(async () => {
            // 获取或创建议事流程
            const { process, error } = await CourtService.getOrCreateProcess(
                interaction.message,
                targetId,
                type,
                guildConfig,
            );

            if (error) {
                return { error };
            }

            // 使用CourtService添加支持者
            const {
                process: updatedProcess,
                supportCount,
                replyContent,
            } = await CourtService.addSupporter(interaction.message.id, interaction.user.id);

            return { updatedProcess, supportCount, replyContent };
        });

        if (result.error) {
            return await interaction.editReply({
                content: `❌ ${result.error}`,
            });
        }

        const { updatedProcess, supportCount, replyContent } = result;
        let finalReplyContent = replyContent;

        // 检查是否达到所需支持数量
        if (supportCount === guildConfig.courtSystem.requiredSupports) {
            try {
                const { debateThread, error: completeError } = await CourtService.handleCourtComplete(
                    updatedProcess,
                    guildConfig,
                    interaction.client,
                );

                if (completeError) {
                    return await interaction.editReply({
                        content: `❌ ${completeError}`,
                    });
                }

                // 更新消息
                const message = await interaction.message.fetch();
                await CourtService.updateCourtMessage(message, updatedProcess, { debateThread });

                // 更新回复内容
                if (updatedProcess.type === 'debate') {
                    finalReplyContent += '\n📢 已达到所需支持人数，等待投票执行';
                } else if (debateThread) {
                    finalReplyContent += `\n📢 已达到所需支持人数，辩诉帖子已创建：${debateThread.url}`;
                }
            } catch (error) {
                logTime(`处理议事完成失败: ${error.message}`, true);
                return await interaction.editReply({
                    content: '❌ 处理议事完成时出错，请稍后重试',
                });
            }
        } else {
            // 更新消息
            const message = await interaction.message.fetch();
            await CourtService.updateCourtMessage(message, updatedProcess);
        }

        // 发送最终确认消息
        return await interaction.editReply({
            content: finalReplyContent,
        });
    } catch (error) {
        await handleInteractionError(interaction, error, 'court_support');
    }
}

/**
 * 处理上诉按钮点击
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 * @param {string} punishmentId - 处罚ID
 */
async function handleAppealButton(interaction, punishmentId) {
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

        // 移除上诉按钮的通用函数
        const removeAppealButton = async errorMessage => {
            try {
                // 先尝试获取用户的DM channel
                const dmChannel = await interaction.user.createDM();
                if (dmChannel) {
                    try {
                        const originalMessage = await dmChannel.messages.fetch(interaction.message.id);
                        if (originalMessage) {
                            await originalMessage.edit({
                                components: [], // 清空所有按钮
                            });
                        }
                    } catch (error) {
                        // 如果获取消息失败，记录日志但不影响主流程
                        logTime(`获取原始上诉消息失败: ${error.message}`, true);
                    }
                }

                // 无论按钮移除是否成功，都发送错误消息
                await interaction.reply({
                    content: `❌ ${errorMessage}`,
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                logTime(`移除上诉按钮失败: ${error.message}`, true);
                // 如果整个过程失败，至少确保发送错误消息
                await interaction.reply({
                    content: `❌ ${errorMessage}`,
                    flags: ['Ephemeral'],
                });
            }
        };

        // 检查处罚状态
        const { isValid, error: statusError } = checkPunishmentStatus(punishment);
        if (!isValid) {
            await removeAppealButton(statusError);
            return;
        }

        // 检查上诉资格
        const { isEligible, error: eligibilityError } = await checkAppealEligibility(interaction.user.id);
        if (!isEligible) {
            await removeAppealButton(eligibilityError);
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
}

// 修改投票按钮处理函数
async function handleVoteButton(interaction, choice) {
    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('vote', interaction.user.id);
        if (cooldownLeft) {
            return await interaction.editReply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次投票`,
            });
        }

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.courtSystem?.enabled) {
            return await interaction.editReply({
                content: '❌ 此服务器未启用议事系统',
            });
        }

        // 检查是否为议员
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(guildConfig.courtSystem.senatorRoleId)) {
            return await interaction.editReply({
                content: '❌ 只有议员可以参与投票',
            });
        }

        // 获取投票ID
        const voteId = parseInt(interaction.customId.split('_')[2]);

        // 获取投票记录
        const vote = await VoteModel.getVoteById(voteId);
        if (!vote) {
            return await interaction.editReply({
                content: '❌ 找不到相关投票',
            });
        }

        // 处理投票
        const {
            vote: updatedVote,
            message: replyContent,
            shouldUpdateMessage,
        } = await VoteService.handleVote(vote, interaction.user.id, choice);

        // 只有在应该更新消息时才更新
        if (shouldUpdateMessage) {
            await VoteService.updateVoteMessage(interaction.message, updatedVote);
        }

        // 回复用户
        await interaction.editReply({
            content: replyContent,
        });

        // 检查是否需要执行结果
        const now = Date.now();
        if (now >= updatedVote.endTime && updatedVote.status === 'in_progress') {
            try {
                // 再次检查投票状态，避免重复结算
                const currentVote = await VoteModel.getVoteById(updatedVote.id);
                if (currentVote.status !== 'in_progress') {
                    logTime(`投票 ${updatedVote.id} 已被其他进程结算，跳过按钮结算`);
                    return;
                }

                // 执行投票结果
                const { result, message: resultMessage } = await VoteService.executeVoteResult(
                    currentVote,
                    interaction.client,
                );

                // 获取最新的投票状态
                const finalVote = await VoteModel.getVoteById(updatedVote.id);

                // 更新消息显示结果
                await VoteService.updateVoteMessage(interaction.message, finalVote, {
                    result,
                    message: resultMessage,
                });
            } catch (error) {
                logTime(`执行投票结果失败: ${error.message}`, true);
                await interaction.followUp({
                    content: '❌ 处理投票结果时出错，请联系管理员',
                    flags: ['Ephemeral'],
                });
            }
        }
    } catch (error) {
        await handleInteractionError(interaction, error, 'vote_button');
    }
}

/**
 * 统一的按钮交互处理函数
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export async function handleButton(interaction) {
    try {
        // 如果是确认按钮（以confirm_开头），直接返回
        if (interaction.customId.startsWith('confirm_')) {
            return;
        }

        // 处理投票按钮
        if (interaction.customId.startsWith('vote_')) {
            const [, choice, processId] = interaction.customId.split('_');
            await handleVoteButton(interaction, choice);
            return;
        }

        // 处理支持按钮
        if (interaction.customId.startsWith('support_')) {
            const [action, type] = interaction.customId.split('_');
            const handler = buttonHandlers[`${action}_${type}`];
            if (handler) {
                await handler(interaction);
                return;
            }
        }

        // 处理上诉按钮
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

        await handler(interaction);
    } catch (error) {
        await handleInteractionError(interaction, error, 'button');
    }
}
