import { ProcessModel } from '../db/models/processModel.js';
import CourtService from '../services/courtService.js';
import {
    createApproveSubmissionModal,
    createCreatorRoleModal,
    createDebateModal,
    createOpinionSubmissionModal,
    createRejectSubmissionModal
} from '../services/modalService.js';
import {
    applyVolunteerRole,
    exitVolunteerRole,
    syncMemberRoles,
    validateVolunteerApplication
} from '../services/roleApplication.js';
import { VoteService } from '../services/voteService.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { globalCooldownManager } from '../utils/cooldownManager.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

/**
 * 查找对应的按钮配置
 * @param {string} customId - 按钮的自定义ID
 * @returns {Object|null} - 按钮配置对象或null
 */
export function findButtonConfig(customId) {
    // 1. 直接匹配
    if (BUTTON_CONFIG[customId]) {
        return BUTTON_CONFIG[customId];
    }

    // 2. 前缀匹配（取前两个部分，如 "support_mute_123" -> "support_mute"）
    const buttonPrefix = customId.split('_').slice(0, 2).join('_');
    if (BUTTON_CONFIG[buttonPrefix]) {
        return BUTTON_CONFIG[buttonPrefix];
    }

    // 3. 动态ID匹配（用于特殊按钮，如投稿审核）
    for (const [key, config] of Object.entries(BUTTON_CONFIG)) {
        if (customId !== key && customId.startsWith(key)) {
            return config;
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

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig.roleApplication?.creatorRoleId) {
            await interaction.reply({
                content: '❌ 服务器未配置创作者身份组功能',
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

    // 志愿者身份组申请按钮处理器
    apply_volunteer_role: async interaction => {

        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig.roleApplication?.volunteerRoleId) {
            await interaction.editReply({
                content: '❌ 服务器未配置志愿者身份组功能',
            });
            return;
        }

        // 检查用户是否已有志愿者身份组
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(guildConfig.roleApplication.volunteerRoleId)) {
            await interaction.editReply({
                content: '❌ 您已经拥有志愿者身份组',
            });
            return;
        }

        // 申请条件验证
        const validationResult = await validateVolunteerApplication(member, guildConfig);
        if (!validationResult.isValid) {
            await interaction.editReply({
                content: `❌ ${validationResult.reason}`,
            });
            return;
        }

        // 如果验证通过，自动授予志愿者身份组
        try {
            await applyVolunteerRole(interaction);
        } catch (error) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.editReply({
                    content: '❌ 申请志愿者身份组时出错，请稍后重试',
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

    // 投稿社区意见按钮处理器
    submit_opinion: async interaction => {
        try {

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

            // 创建批准投稿模态框，传递消息ID
            const modal = createApproveSubmissionModal(userId, submissionType, interaction.message.id);

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'approve_submission');
        }
    },

    // 拒绝投稿按钮处理器
    reject_submission: async interaction => {
        try {
            // 解析按钮ID获取用户ID和投稿类型
            const [, , userId, submissionType] = interaction.customId.split('_');

            // 创建拒绝投稿模态框，传递消息ID
            const modal = createRejectSubmissionModal(userId, submissionType, interaction.message.id);

            await interaction.showModal(modal);
        } catch (error) {
            await handleInteractionError(interaction, error, 'reject_submission');
        }
    },
};

// 按钮配置对象
const BUTTON_CONFIG = {
    // 身份组相关
    apply_creator_role: { handler: buttonHandlers.apply_creator_role, needDefer: false, cooldown: 10000 },
    apply_volunteer_role: { handler: buttonHandlers.apply_volunteer_role, needDefer: true, cooldown: 60000 },
    exit_volunteer_role: { handler: buttonHandlers.exit_volunteer_role, needDefer: true, cooldown: 60000 },
    sync_roles: { handler: buttonHandlers.sync_roles, needDefer: true, cooldown: 60000 },

    // 议事系统相关
    start_debate: { handler: buttonHandlers.start_debate, needDefer: false, cooldown: 10000 },
    support_mute: { handler: interaction => CourtService.handleSupport(interaction, 'mute'), needDefer: true, cooldown: 10000 },
    support_ban: { handler: interaction => CourtService.handleSupport(interaction, 'ban'), needDefer: true, cooldown: 10000 },
    support_debate: { handler: interaction => CourtService.handleSupport(interaction, 'debate'), needDefer: true, cooldown: 10000 },
    support_impeach: { handler: interaction => CourtService.handleSupport(interaction, 'impeach'), needDefer: true, cooldown: 10000 },
    revoke_process: { handler: buttonHandlers.revoke_process, needDefer: true },

    // 投票相关
    vote_red: { handler: interaction => VoteService.handleVoteButton(interaction, 'red'), needDefer: true, cooldown: 60000 },
    vote_blue: { handler: interaction => VoteService.handleVoteButton(interaction, 'blue'), needDefer: true, cooldown: 60000 },

    // 翻页相关
    page_prev: { handler: buttonHandlers.page_prev, needDefer: false },
    page_next: { handler: buttonHandlers.page_next, needDefer: false },

    // 投稿相关
    submit_opinion: { handler: buttonHandlers.submit_opinion, needDefer: false, cooldown: 30000 },
    approve_submission: { handler: buttonHandlers.approve_submission, needDefer: false },
    reject_submission: { handler: buttonHandlers.reject_submission, needDefer: false },
};

/**
 * 统一的按钮交互处理函数
 * @param {ButtonInteraction} interaction - Discord按钮交互对象
 */
export async function handleButton(interaction) {
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

    // 3. 检查冷却时间
    if (buttonConfig.cooldown) {
        const cooldownCheck = await globalCooldownManager.checkCooldown(interaction, {
            type: 'button',
            key: interaction.customId.split('_')[0], // 使用按钮类型作为冷却键
            duration: buttonConfig.cooldown
        });

        if (cooldownCheck.inCooldown) {
            await cooldownCheck.reply();
            return;
        }
    }

    // 4. 根据配置决定是否需要defer
    if (buttonConfig.needDefer) {
        await interaction.deferReply({ flags: ['Ephemeral'] });
    }

    // 5. 根据按钮类型决定是否需要队列处理
    const buttonType = interaction.customId.split('_')[0];
    const queuedButtonTypes = ['court', 'vote', 'support'];

    if (queuedButtonTypes.includes(buttonType)) {
        const priority = buttonType === 'appeal' ? 4 : 3;

        await ErrorHandler.handleInteraction(
            interaction,
            () => globalRequestQueue.add(() => buttonConfig.handler(interaction), priority),
            '按钮交互处理',
            { ephemeral: true }
        );
    } else {
        await ErrorHandler.handleInteraction(
            interaction,
            () => buttonConfig.handler(interaction),
            '按钮交互处理',
            { ephemeral: true }
        );
    }
}
