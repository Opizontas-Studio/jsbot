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
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import CourtService from '../services/courtService.js';
import { syncMemberRoles } from '../services/roleApplication.js';
import { VoteService } from '../services/voteService.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { checkAppealEligibility, checkPunishmentStatus } from '../utils/punishmentHelper.js';
import { globalTaskScheduler } from './scheduler.js';

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
    timeout = 120000,
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
function checkCooldown(type, userId, duration = 10000) {
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
    // 身份组申请按钮处理器 - 不需要defer（显示模态框）
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
        const cooldownLeft = checkCooldown('start_debate', interaction.user.id, 60000); // 1分钟冷却
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
            .setLabel('提案原因（20到300字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明提出此议案的原因')
            .setMinLength(20)
            .setMaxLength(300)
            .setRequired(true);

        // 动议输入
        const motionInput = new TextInputBuilder()
            .setCustomId('debate_motion')
            .setLabel('议案动议（20到300字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明您的动议内容，具体的目标是什么')
            .setMinLength(20)
            .setMaxLength(300)
            .setRequired(true);

        // 执行方式输入
        const implementationInput = new TextInputBuilder()
            .setCustomId('debate_implementation')
            .setLabel('执行方案（30到600字，可以分段、换行）')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请详细说明如何执行此动议，包括执行人是谁，执行方式，如何考核监督等')
            .setMinLength(30)
            .setMaxLength(600)
            .setRequired(true);

        // 投票时间输入
        const voteTimeInput = new TextInputBuilder()
            .setCustomId('debate_vote_time')
            .setLabel('投票时间（不超过7天）')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('填写格式形如：1天')
            .setMaxLength(10)
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

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason: `由申请人 ${interaction.user.tag} 撤销`,
            });

            try {
                // 直接删除流程消息
                await message.delete();
                logTime(`流程消息已被删除: ${message.id}, 类型: ${process.type}`);
            } catch (error) {
                logTime(`删除流程消息失败: ${error.message}`, true);
                // 即使删除失败，我们仍然继续处理流程撤销
            }

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

            // 检查是否是提交者本人
            if (interaction.user.id !== submitterId) {
                await interaction.editReply({
                    content: '❌ 只有申请人本人可以撤销上诉',
                });
                return;
            }

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
                try {
                    const dmChannel = await interaction.user.createDM();
                    if (dmChannel && originalMessageId) {
                        const originalMessage = await dmChannel.messages.fetch(originalMessageId).catch(() => null);
                        if (originalMessage) {
                            await originalMessage.edit({ components: [] });
                            logTime(`已移除已结束上诉的撤回按钮: ${originalMessageId}`);
                        }
                    }
                } catch (error) {
                    logTime(`移除已结束上诉按钮失败: ${error.message}`, true);
                }
                return;
            }

            // 获取主服务器配置
            const mainGuildConfig = interaction.client.guildManager
                .getGuildIds()
                .map(id => interaction.client.guildManager.getGuildConfig(id))
                .find(config => config?.serverType === 'Main server');

            // 尝试删除议事区消息
            try {
                if (process.messageId) {
                    // 使用议事区配置的频道ID
                    const courtChannelId = mainGuildConfig?.courtSystem?.courtChannelId;

                    if (courtChannelId) {
                        // 尝试从主服务器获取议事频道
                        const courtChannel = await interaction.client.channels.fetch(courtChannelId).catch(err => {
                            logTime(`获取议事频道失败: ${err.message}`, true);
                            return null;
                        });

                        if (courtChannel) {
                            const courtMessage = await courtChannel.messages.fetch(process.messageId).catch(err => {
                                logTime(`获取议事消息失败: ${err.message}`, true);
                                return null;
                            });

                            if (courtMessage) {
                                await courtMessage.delete();
                                logTime(`上诉议事消息已被删除: ${process.messageId}`);
                            } else {
                                logTime(`未找到上诉议事消息: ${process.messageId}`, true);
                            }
                        }
                    } else {
                        logTime(`找不到议事区频道ID，无法删除上诉消息`, true);
                    }
                } else {
                    logTime(`流程中无消息ID，无法删除上诉消息`, true);
                }
            } catch (error) {
                logTime(`删除上诉议事消息失败: ${error.message}`, true);
                // 继续执行，不影响主流程
            }

            // 更新流程状态
            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason: `由申请人 ${interaction.user.tag} 撤销上诉`,
            });

            // 取消计时器
            await globalTaskScheduler.getProcessScheduler().cancelProcess(process.id);

            // 更新原始消息，移除撤回按钮
            try {
                const dmChannel = await interaction.user.createDM();
                if (dmChannel && originalMessageId) {
                    const originalMessage = await dmChannel.messages.fetch(originalMessageId).catch(() => null);
                    if (originalMessage) {
                        await originalMessage.edit({ components: [] });
                        logTime(`已移除上诉撤回按钮: ${originalMessageId}`);
                    }
                }
            } catch (error) {
                logTime(`移除上诉按钮失败: ${error.message}`, true);
                // 继续执行，不影响主流程
            }

            // 记录操作日志
            logTime(`上诉流程 ${process.id} 已被申请人 ${interaction.user.tag} 撤销`);

            await interaction.editReply({
                content: '✅ 上诉申请已成功撤销',
            });
        } catch (error) {
            await handleInteractionError(interaction, error, 'revoke_appeal');
        }
    },
};

/**
 * 处理议事区支持按钮
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 * @param {string} type - 议事类型 ('mute' | 'ban' | 'appeal' | 'debate')
 */
async function handleCourtSupport(interaction, type) {
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
        if (!member.roles.cache.has(guildConfig.roleApplication?.senatorRoleId)) {
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

// 投票按钮处理函数
async function handleVoteButton(interaction, choice) {
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
        if (!member.roles.cache.has(guildConfig.roleApplication?.senatorRoleId)) {
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

// 按钮处理配置对象
const BUTTON_CONFIG = {
    // 需要defer的按钮
    deferButtons: {
        support_mute: { handler: interaction => handleCourtSupport(interaction, 'mute') },
        support_ban: { handler: interaction => handleCourtSupport(interaction, 'ban') },
        support_appeal: { handler: interaction => handleCourtSupport(interaction, 'appeal') },
        support_debate: { handler: interaction => handleCourtSupport(interaction, 'debate') },
        vote_red: { handler: interaction => handleVoteButton(interaction, 'red') },
        vote_blue: { handler: interaction => handleVoteButton(interaction, 'blue') },
        sync_roles: { handler: buttonHandlers.sync_roles },
        revoke_process: { handler: buttonHandlers.revoke_process },
        revoke_appeal: { handler: buttonHandlers.revoke_appeal },
    },

    // 不需要defer的按钮（显示模态框）
    modalButtons: {
        appeal_: interaction => {
            const punishmentId = interaction.customId.split('_')[1];
            return handleAppealButton(interaction, punishmentId);
        },
        apply_creator_role: buttonHandlers.apply_creator_role,
        start_debate: buttonHandlers.start_debate,
        page_prev: buttonHandlers.page_prev,
        page_next: buttonHandlers.page_next,
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

/**
 * 查找对应的按钮配置
 * @param {string} customId - 按钮的自定义ID
 * @returns {Object|null} - 按钮配置对象或null
 */
function findButtonConfig(customId) {
    // 检查完全匹配的defer按钮
    const buttonPrefix = customId.split('_').slice(0, 2).join('_');
    if (BUTTON_CONFIG.deferButtons[buttonPrefix]) {
        return {
            needDefer: true,
            handler: BUTTON_CONFIG.deferButtons[buttonPrefix].handler,
        };
    }

    // 检查完全匹配的非defer按钮
    if (BUTTON_CONFIG.modalButtons[buttonPrefix]) {
        return {
            needDefer: false,
            handler: BUTTON_CONFIG.modalButtons[buttonPrefix],
        };
    }

    // 检查前缀匹配的模态框按钮
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
