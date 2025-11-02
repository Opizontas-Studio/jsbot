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

    /**
     * 创建解锁子区申请模态框
     * @param {string} threadId - 要解锁的子区ID
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createUnlockThreadModal(threadId) {
        const modal = new ModalBuilder()
            .setCustomId(`unlock_thread_modal_${threadId}`)
            .setTitle('申请解锁子区');

        const reasonInput = new TextInputBuilder()
            .setCustomId('unlock_reason')
            .setLabel('解锁理由')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('请简单说明为什么需要解锁此帖子...')
            .setMinLength(10)
            .setMaxLength(500)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(reasonInput),
        );

        return modal;
    }

    /**
     * 创建频道轮播配置模态框
     * @param {string} channelId - 频道ID
     * @param {string} operationType - 操作类型（create或edit）
     * @param {Object} existingConfig - 现有配置（编辑时）
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createChannelCarouselConfigModal(channelId, operationType, existingConfig = null) {
        const isEdit = operationType === 'edit';
        const modal = new ModalBuilder()
            .setCustomId(`channel_carousel_config_${operationType}_${channelId}`)
            .setTitle(isEdit ? '编辑频道轮播配置' : '创建频道轮播配置');

        const titleInput = new TextInputBuilder()
            .setCustomId('carousel_title')
            .setLabel('轮播标题')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例如：重要公告')
            .setMaxLength(100)
            .setRequired(true);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('carousel_description')
            .setLabel('轮播描述')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('可选，用于描述此轮播的用途')
            .setMaxLength(1000)
            .setRequired(false);

        const footerInput = new TextInputBuilder()
            .setCustomId('carousel_footer')
            .setLabel('轮播页脚')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('可选，显示在轮播底部的文字')
            .setMaxLength(100)
            .setRequired(false);

        // 如果是编辑模式，预填充现有值
        if (isEdit && existingConfig) {
            if (existingConfig.title) titleInput.setValue(existingConfig.title);
            if (existingConfig.description) descriptionInput.setValue(existingConfig.description);
            if (existingConfig.footer) footerInput.setValue(existingConfig.footer);
        }

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(footerInput),
        );

        return modal;
    }

    /**
     * 创建频道轮播条目模态框
     * @param {string} channelId - 频道ID
     * @param {string} operationType - 操作类型（add或edit）
     * @param {string} itemId - 条目ID（编辑时）
     * @param {string} existingContent - 现有内容（编辑时）
     * @returns {ModalBuilder} 构建好的模态框
     */
    static createChannelCarouselItemModal(channelId, operationType, itemId = null, existingContent = '') {
        const isEdit = operationType === 'edit';
        const modal = new ModalBuilder()
            .setCustomId(`channel_carousel_item_${operationType}_${channelId}${itemId ? `_${itemId}` : ''}`)
            .setTitle(isEdit ? '编辑轮播条目' : '新增轮播条目');

        const contentInput = new TextInputBuilder()
            .setCustomId('item_content')
            .setLabel('条目内容')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('支持Markdown格式，多行时第一行作为标题\n例如：\n重要更新\n我们将在本周末进行系统维护...')
            .setMinLength(1)
            .setMaxLength(400)
            .setRequired(true);

        // 如果是编辑模式，预填充现有内容
        if (isEdit && existingContent) {
            contentInput.setValue(existingContent);
        }

        modal.addComponents(
            new ActionRowBuilder().addComponents(contentInput),
        );

        return modal;
    }
}
