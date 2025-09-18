import { opinionMailboxService } from '../services/opinionMailboxService.js';
import { handleCreatorRoleApplication } from '../services/roleApplication.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 处理意见投稿提交
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 * @param {string} type - 投稿类型（固定为opinion）
 * @param {string} titlePrefix - 标题前缀
 * @param {number} color - 嵌入消息颜色
 */
const handleSubmission = async (interaction, type, titlePrefix, color) => {
    return await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 获取用户输入
            const title = interaction.fields.getTextInputValue(`${type}_title`);
            const content = interaction.fields.getTextInputValue(`${type}_content`);

            // 调用服务层处理业务逻辑
            const result = await opinionMailboxService.handleOpinionSubmission(
                interaction.client,
                interaction.guildId,
                interaction.user,
                title,
                content,
                type,
                titlePrefix,
                color
            );

            if (!result.success) {
                throw new Error(result.error || '处理投稿失败');
            }
        },
        "提交社区意见",
        { successMessage: "社区意见已成功提交！" }
    );
};

/**
 * 投稿审核处理
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 * @param {boolean} isApproved - 是否批准（true为批准，false为拒绝）
 */
const handleSubmissionReview = async (interaction, isApproved) => {
    return await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 从modalId中解析用户ID、投稿类型和消息ID
            const modalIdParts = interaction.customId.split('_');
            const userId = modalIdParts[3];
            const submissionType = modalIdParts[4];
            const messageId = modalIdParts[5];

            // 获取管理员输入的回复内容
            const adminReply = interaction.fields.getTextInputValue('admin_reply');

            // 调用服务层处理业务逻辑
            const result = await opinionMailboxService.handleSubmissionReview(
                interaction.client,
                interaction,
                isApproved,
                userId,
                submissionType,
                messageId,
                adminReply
            );

            if (!result.success) {
                throw new Error(result.error || '处理审核失败');
            }
        },
        `${isApproved ? '审定通过' : '拒绝'}投稿`,
        { successMessage: `已将该社区意见标记为${isApproved ? '合理' : '不合理'}并发送了自定义回复` }
    );
};

/**
 * 模态框处理器映射
 * 每个处理器函数接收一个 ModalSubmitInteraction 参数
 */
export const modalHandlers = {
    // 身份组申请模态框处理器
    creator_role_modal: async interaction => {
        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const threadLink = interaction.fields.getTextInputValue('thread_link');

                // 调用服务层处理业务逻辑
                const result = await handleCreatorRoleApplication(
                    interaction.client,
                    interaction,
                    threadLink
                );

                if (!result.success) {
                    throw new Error(result.error || result.message || '处理申请失败');
                }

                // 手动发送成功消息
                await interaction.editReply(`✅ ${result.data.message}`);
            },
            "处理创作者身份组申请"
        );
    },
    // 议事模态框处理器
    submit_debate_modal: async interaction => {
        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                // 获取用户输入
                const title = interaction.fields.getTextInputValue('debate_title');
                const reason = interaction.fields.getTextInputValue('debate_reason');
                const motion = interaction.fields.getTextInputValue('debate_motion');
                const implementation = interaction.fields.getTextInputValue('debate_implementation');
                const voteTime = interaction.fields.getTextInputValue('debate_vote_time');

                // 调用服务层处理业务逻辑
                const result = await CourtService.handleDebateSubmission(
                    interaction.client,
                    interaction,
                    title,
                    reason,
                    motion,
                    implementation,
                    voteTime
                );

                if (!result.success) {
                    throw new Error(result.error || '处理议事申请失败');
                }

                // 手动发送成功消息
                await interaction.editReply(`✅ 已提交议事申请\n👉 [点击查看议事消息](${result.data.message.url})`);
            },
            "提交议事申请"
        );
    },

    // 社区意见投稿模态框处理器
    opinion_submission_modal: async interaction => {
        await handleSubmission(interaction, 'opinion', '💬 社区意见：', 0x2ecc71); // 绿色
    },

    // 批准投稿模态框处理器
    approve_submission_modal: async interaction => {
        await handleSubmissionReview(interaction, true);
    },

    // 拒绝投稿模态框处理器
    reject_submission_modal: async interaction => {
        await handleSubmissionReview(interaction, false);
    },
};

/**
 * 统一的模态框交互处理函数
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export async function handleModal(interaction) {
    // 模态框提交需要defer reply
    await interaction.deferReply({ flags: ['Ephemeral'] });

    // 获取基础模态框ID
    const modalId = interaction.customId;
    let handler = modalHandlers[modalId];

    // 如果没有找到精确匹配，尝试前缀匹配（用于动态ID的模态框）
    if (!handler) {
        // 检查是否是批准或拒绝投稿的模态框
        if (modalId.startsWith('approve_submission_modal_')) {
            handler = modalHandlers.approve_submission_modal;
        } else if (modalId.startsWith('reject_submission_modal_')) {
            handler = modalHandlers.reject_submission_modal;
        }
    }

    if (!handler) {
        logTime(`未找到模态框处理器: ${interaction.customId}`, true);
        return;
    }

    await handler(interaction);
}
