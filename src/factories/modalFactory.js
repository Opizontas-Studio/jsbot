import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

/**
 * Modal工厂类
 * 负责创建各种Discord Modal对象
 */
export class ModalFactory {
    /**
     * 创建创作者身份组申请模态框
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createCreatorRoleModal() {
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

        return modal;
    }

    /**
     * 创建提交议事模态框
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createDebateModal() {
        const modal = new ModalBuilder()
            .setCustomId('submit_debate_modal')
            .setTitle('提交议事');

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

        return modal;
    }

    /**
     * 创建社区意见投稿模态框
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createOpinionSubmissionModal() {
        const modal = new ModalBuilder()
            .setCustomId('opinion_submission_modal')
            .setTitle('社区意见投稿');

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

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(contentInput),
        );

        return modal;
    }

    /**
     * 创建批准投稿回复模态框
     * @param {string} userId - 投稿用户ID
     * @param {string} submissionType - 投稿类型（news或opinion）
     * @param {string} messageId - 原始消息ID
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createApproveSubmissionModal(userId, submissionType, messageId) {
        const modal = new ModalBuilder()
            .setCustomId(`approve_submission_modal_${userId}_${submissionType}_${messageId}`)
            .setTitle('批准投稿 - 编写回复');

        const replyInput = new TextInputBuilder()
            .setCustomId('admin_reply')
            .setLabel('给投稿者的回复消息')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请输入要发送给投稿者的回复内容...')
            .setMinLength(10)
            .setMaxLength(1000)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(replyInput),
        );

        return modal;
    }

    /**
     * 创建拒绝投稿回复模态框
     * @param {string} userId - 投稿用户ID
     * @param {string} submissionType - 投稿类型（news或opinion）
     * @param {string} messageId - 原始消息ID
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createRejectSubmissionModal(userId, submissionType, messageId) {
        const modal = new ModalBuilder()
            .setCustomId(`reject_submission_modal_${userId}_${submissionType}_${messageId}`)
            .setTitle('拒绝投稿 - 编写回复');

        const replyInput = new TextInputBuilder()
            .setCustomId('admin_reply')
            .setLabel('给投稿者的回复消息')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请输入要发送给投稿者的回复内容，说明拒绝原因...')
            .setMinLength(10)
            .setMaxLength(1000)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(replyInput),
        );

        return modal;
    }

    /**
     * 创建编辑bot消息模态框
     * @param {string} messageId - 要编辑的消息ID
     * @param {string} currentContent - 当前消息内容
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createEditBotMessageModal(messageId, currentContent) {
        const modal = new ModalBuilder()
            .setCustomId(`edit_bot_message_modal_${messageId}`)
            .setTitle('编辑Bot消息');

        const contentInput = new TextInputBuilder()
            .setCustomId('message_content')
            .setLabel('消息内容')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请输入新的消息内容...')
            .setValue(currentContent || '')
            .setMaxLength(2000)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(contentInput),
        );

        return modal;
    }
}
