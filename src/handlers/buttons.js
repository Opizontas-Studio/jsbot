import { Collection } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import CourtService from '../services/courtService.js';
import {
    createAppealModal,
    createCreatorRoleModal,
    createDebateModal,
    createNewsSubmissionModal,
    createOpinionSubmissionModal,
} from '../services/modalService.js';
import {
    applyVolunteerRole,
    exitSenatorRole,
    exitVolunteerRole,
    syncMemberRoles,
    updateOpinionRecord,
    validateVolunteerApplication
} from '../services/roleApplication.js';
import { VoteService } from '../services/voteService.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { checkAppealEligibility } from '../utils/punishmentHelper.js';

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
        const modal = createCreatorRoleModal();

        await interaction.showModal(modal);
    },

    // 议员身份组自助退出按钮处理器
    exit_senator_role: async interaction => {
        await exitSenatorRole(interaction);
    },

    // 志愿者身份组申请按钮处理器
    apply_volunteer_role: async interaction => {
        // 检查冷却时间
        const cooldownLeft = checkCooldown('volunteer_apply', interaction.user.id, 60000); // 1分钟冷却
        if (cooldownLeft) {
            await interaction.reply({
                content: `❌ 请等待 ${cooldownLeft} 秒后再次申请`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig || !guildConfig.roleApplication || !guildConfig.roleApplication.volunteerRoleId) {
            await interaction.reply({
                content: '❌ 服务器未正确配置志愿者身份组',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查用户是否已有志愿者身份组
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(guildConfig.roleApplication.volunteerRoleId)) {
            await interaction.reply({
                content: '❌ 您已经拥有志愿者身份组',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 申请条件验证
        const validationResult = await validateVolunteerApplication(member, guildConfig);
        if (!validationResult.isValid) {
            await interaction.reply({
                content: `❌ ${validationResult.reason}`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 如果验证通过，自动授予志愿者身份组
        try {
            await applyVolunteerRole(interaction);
        } catch (error) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ 申请志愿者身份组时出错，请稍后重试',
                    flags: ['Ephemeral'],
                });
            }
            logTime(`志愿者申请失败: ${error.message}`, true);
        }
    },

    // 志愿者身份组退出按钮处理器
    exit_volunteer_role: async interaction => {
        await exitVolunteerRole(interaction);
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
        const modal = createDebateModal();

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

            // 使用CourtService撤销流程
            const result = await CourtService.revokeProcess({
                messageId: message.id,
                revokedBy: interaction.user,
                isAdmin: false,
                client: interaction.client,
                user: interaction.user
            });

            await interaction.editReply({
                content: result.success ? result.message : `❌ ${result.message}`,
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

            // 使用CourtService撤销流程
            const result = await CourtService.revokeProcess({
                processId: processId,
                revokedBy: interaction.user,
                isAdmin: false,
                originalMessageId: originalMessageId,
                client: interaction.client,
                user: interaction.user
            });

            await interaction.editReply({
                content: result.success ? result.message : `❌ ${result.message}`,
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

            // 检查上诉资格
            const {
                isEligible,
                error: eligibilityError,
                punishment,
            } = await checkAppealEligibility(interaction.user.id, punishmentId);
            if (!isEligible) {
                await CourtService.removeAppealButton(interaction.user, interaction.message.id);
                await interaction.reply({
                    content: `❌ ${eligibilityError}`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 调试日志
            logTime(`用户申请上诉，处罚记录状态: ID=${punishmentId}, status=${punishment.status}`);

            // 创建上诉表单
            const modal = createAppealModal(punishmentId, interaction.message.id);

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
            const modal = createNewsSubmissionModal();

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
            const modal = createOpinionSubmissionModal();

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'submit_opinion_button');
        }
    },

    // 批准投稿按钮处理器
    approve_submission: async interaction => {
        try {
            // 解析按钮ID获取用户ID和投稿类型
            const [, , userId, submissionType] = interaction.customId.split('_');

            // 从embed中提取投稿信息
            const originalEmbed = interaction.message.embeds[0];
            let submissionData = null;

            if (originalEmbed) {
                // 提取标题（去掉前缀）
                let title = originalEmbed.title || '未记录标题';
                if (title.startsWith('📰 新闻投稿：')) {
                    title = title.replace('📰 新闻投稿：', '').trim();
                } else if (title.startsWith('💬 社区意见：')) {
                    title = title.replace('💬 社区意见：', '').trim();
                }

                // 提取内容
                const content = originalEmbed.description || '未记录内容';

                submissionData = {
                    title: title,
                    content: content
                };
            }

            // 更新意见记录
            const result = await updateOpinionRecord(userId, submissionType, true, submissionData);

            if (result.success) {
                // 更新消息的embed
                const updatedEmbed = {
                    ...originalEmbed.toJSON(),
                    footer: {
                        text: '审定有效，可申请志愿者身份组'
                    }
                };

                // 移除按钮并更新消息
                await interaction.message.edit({
                    embeds: [updatedEmbed],
                    components: []
                });

                // 向目标用户发送私聊通知
                try {
                    const targetUser = await interaction.client.users.fetch(userId);
                    if (targetUser) {
                        const dmEmbed = {
                            color: 0x00ff00,
                            title: '✅ 投稿审定通过',
                            description: [
                                `感谢您投稿的${submissionType === 'news' ? '新闻投稿' : '社区意见'}`,
                                '',
                                `**投稿标题：${submissionData?.title || '未知标题'}**`,
                                '您现在可以在[相关频道](https://discord.com/channels/1291925535324110879/1374312282351468626)申请社区志愿者身份组，参与重大决策的投票。',
                            ].join('\n'),
                            timestamp: new Date(),
                        };

                        await targetUser.send({ embeds: [dmEmbed] });
                        logTime(`已向用户 ${targetUser.tag} 发送投稿审定通过通知`);
                    }
                } catch (dmError) {
                    logTime(`向用户 ${userId} 发送投稿审定通知失败: ${dmError.message}`, true);
                    // 私聊发送失败不影响主流程
                }

                await interaction.editReply({
                    content: `✅ 已将该${submissionType === 'news' ? '新闻投稿' : '社区意见'}标记为合理`,
                });

                logTime(`管理员 ${interaction.user.tag} 批准了用户 ${userId} 的${submissionType === 'news' ? '新闻投稿' : '社区意见'}: "${submissionData?.title || '未知标题'}"`);
            } else {
                await interaction.editReply({
                    content: `❌ ${result.message}`,
                });
            }
        } catch (error) {
            await handleInteractionError(interaction, error, 'approve_submission');
        }
    },

    // 拒绝投稿按钮处理器
    reject_submission: async interaction => {
        try {
            // 解析按钮ID获取用户ID和投稿类型
            const [, , userId, submissionType] = interaction.customId.split('_');

            // 更新消息的embed
            const originalEmbed = interaction.message.embeds[0];
            const updatedEmbed = {
                ...originalEmbed.toJSON(),
                footer: {
                    text: '审定无效'
                }
            };

            // 移除按钮并更新消息
            await interaction.message.edit({
                embeds: [updatedEmbed],
                components: []
            });

            await interaction.editReply({
                content: `✅ 已将该${submissionType === 'news' ? '新闻投稿' : '社区意见'}标记为不合理`,
            });

            logTime(`管理员 ${interaction.user.tag} 拒绝了用户 ${userId} 的${submissionType === 'news' ? '新闻投稿' : '社区意见'}`);
        } catch (error) {
            await handleInteractionError(interaction, error, 'reject_submission');
        }
    },
};

// 按钮处理配置对象
const BUTTON_CONFIG = {
    // 需要defer的按钮
    deferButtons: {
        exit_senator_role: { handler: buttonHandlers.exit_senator_role },
        apply_volunteer_role: { handler: buttonHandlers.apply_volunteer_role },
        exit_volunteer_role: { handler: buttonHandlers.exit_volunteer_role },
        approve_submission: { handler: buttonHandlers.approve_submission },
        reject_submission: { handler: buttonHandlers.reject_submission },
        support_mute: { handler: interaction => CourtService.handleSupport(interaction, 'mute') },
        support_ban: { handler: interaction => CourtService.handleSupport(interaction, 'ban') },
        support_appeal: { handler: interaction => CourtService.handleSupport(interaction, 'appeal') },
        support_debate: { handler: interaction => CourtService.handleSupport(interaction, 'debate') },
        support_impeach: { handler: interaction => CourtService.handleSupport(interaction, 'impeach') },
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
