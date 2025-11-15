import { carouselServiceManager } from '../services/carousel/carouselManager.js';
import { opinionMailboxService } from '../services/user/opinionMailboxService.js';
import { handleCreatorRoleApplication } from '../services/role/creatorRoleService.js';
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

                // 发送成功消息embed
                await interaction.editReply({
                    embeds: [result.data.embed]
                });
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

    // 编辑bot消息模态框处理器
    edit_bot_message_modal: async interaction => {
        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                // 从modalId中解析消息ID - 使用前缀匹配而不是split
                const messageId = interaction.customId.replace('edit_bot_message_modal_', '');

                // 获取用户输入的新内容
                const newContent = interaction.fields.getTextInputValue('message_content');

                // 获取目标消息
                const targetMessage = await interaction.channel.messages.fetch(messageId);

                // 再次验证消息是否由bot发送（防止在模态框提交期间消息被删除或替换）
                if (!targetMessage || targetMessage.author.id !== interaction.client.user.id) {
                    throw new Error('目标消息不存在');
                }

                // 编辑消息，保留原始附件
                await targetMessage.edit({
                    content: newContent,
                    files: targetMessage.attachments.map(attachment => ({
                        attachment: attachment.url,
                        name: attachment.name,
                    })),
                });
            },
            "编辑Bot消息",
            { successMessage: "Bot消息已成功编辑" }
        );
    },

    // 解锁子区申请模态框处理器
    unlock_thread_modal: async interaction => {
        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                // 从modalId中解析子区ID
                const threadId = interaction.customId.replace('unlock_thread_modal_', '');

                // 获取用户输入的解锁理由
                const unlockReason = interaction.fields.getTextInputValue('unlock_reason');

                // 获取子区对象
                const thread = await interaction.client.channels.fetch(threadId);
                if (!thread || !thread.isThread()) {
                    throw new Error('无法获取目标子区');
                }

                // 获取服务器配置
                const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

                // 调用服务层处理业务逻辑
                const result = await opinionMailboxService.handleUnlockRequest(
                    interaction.client,
                    interaction.user,
                    thread,
                    unlockReason,
                    guildConfig.opinionMailThreadId
                );

                if (!result.success) {
                    throw new Error(result.error || '提交解锁申请失败');
                }
            },
            "提交解锁申请",
            { successMessage: "解锁申请已提交，请等待管理员审核" }
        );
    },

    // 频道轮播配置模态框处理器
    channel_carousel_config: async interaction => {
        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                // 从modalId中解析tempKey和操作类型
                const parts = interaction.customId.split('_');
                const operationType = parts[3]; // create or edit
                const tempKey = parts.slice(4).join('_');

                // 获取临时配置
                const tempConfig = interaction.client.tempCarouselConfigs?.get(tempKey);
                if (!tempConfig) {
                    throw new Error('配置已过期，请重新操作');
                }

                // 清理临时配置
                interaction.client.tempCarouselConfigs.delete(tempKey);

                // 提取guildId和channelId
                const [guildId, channelId] = tempKey.split('-').slice(0, 2);

                // 获取用户输入
                const title = interaction.fields.getTextInputValue('carousel_title');
                const description = interaction.fields.getTextInputValue('carousel_description');
                const footer = interaction.fields.getTextInputValue('carousel_footer');

                // 构建完整配置
                const config = {
                    ...tempConfig,
                    title,
                    description: description || '',
                    footer: footer || '',
                };

                // 保存配置
                const channelCarousel = carouselServiceManager.getChannelCarousel();
                await channelCarousel.saveChannelCarouselConfig(guildId, channelId, config);

                logTime(`[频道轮播] 用户 ${interaction.user.tag} ${operationType === 'create' ? '创建' : '编辑'}了频道 ${channelId} 的轮播配置`);

                // 启动轮播（如果有条目）或创建空消息（如果没有条目）
                const channel = await interaction.client.channels.fetch(channelId);
                if (config.items && config.items.length > 0) {
                    await channelCarousel.startChannelCarousel(channel, guildId, channelId);
                } else {
                    // 创建一个提示消息
                    await channelCarousel.createEmptyCarouselMessage(channel, guildId, channelId, config);
                }
            },
            "保存轮播配置",
            { successMessage: "轮播配置已保存，请添加条目后轮播将自动启动" }
        );
    },

    // 频道轮播条目模态框处理器
    channel_carousel_item: async interaction => {
        // 解析操作类型
        const parts = interaction.customId.split('_');
        const operationType = parts[3]; // add or edit

        return await ErrorHandler.handleInteraction(
            interaction,
            async () => {
                const channelIdPart = parts[4];

                // channelIdPart可能是 "channelId" 或 "channelId_customId"
                const channelIdAndCustomId = channelIdPart.split('_');
                const channelId = channelIdAndCustomId[0];
                const customId = channelIdAndCustomId[1] ? parseInt(channelIdAndCustomId[1]) : null;

                const itemId = parts[5] ? parseInt(parts[5]) : null;

                const guildId = interaction.guildId;

                // 获取用户输入
                const content = interaction.fields.getTextInputValue('item_content');

                // 获取现有配置
                const channelCarousel = carouselServiceManager.getChannelCarousel();
                const config = await channelCarousel.getChannelCarouselConfig(guildId, channelId);
                if (!config) {
                    throw new Error('轮播配置不存在');
                }

                if (operationType === 'add') {
                    // 新增条目，使用自定义ID或生成下一个ID
                    const nextId = customId || (config.items.length > 0
                        ? Math.max(...config.items.map(i => i.id)) + 1
                        : 1);
                    const newItem = {
                        id: nextId,
                        content,
                    };
                    config.items.push(newItem);
                    logTime(`[频道轮播] 用户 ${interaction.user.tag} 新增了频道 ${channelId} 的轮播条目 ID ${nextId}`);
                } else if (operationType === 'edit') {
                    // 编辑条目
                    const item = config.items.find(i => i.id === itemId);
                    if (!item) {
                        throw new Error('条目不存在');
                    }
                    item.content = content;
                    logTime(`[频道轮播] 用户 ${interaction.user.tag} 编辑了频道 ${channelId} 的轮播条目 ID ${itemId}`);
                }

                // 保存配置
                await channelCarousel.saveChannelCarouselConfig(guildId, channelId, config);

                // 重启轮播
                const channel = await interaction.client.channels.fetch(channelId);
                await channelCarousel.startChannelCarousel(channel, guildId, channelId);
            },
            operationType === 'add' ? "新增条目" : "编辑条目",
            { successMessage: `条目已${operationType === 'add' ? '新增' : '编辑'}` }
        );
    },
};

/**
 * 统一的模态框交互处理函数
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export async function handleModal(interaction) {
    // 模态框提交需要defer reply
    try {
        await interaction.deferReply({ flags: ['Ephemeral'] });
    } catch (error) {
        logTime(`[模态框${interaction.customId}] deferReply失败: ${error.message}`, true);
        return;
    }

    // 获取基础模态框ID
    const modalId = interaction.customId;
    let handler = modalHandlers[modalId];

    // 如果没有找到精确匹配，尝试前缀匹配（用于动态ID的模态框）
    if (!handler) {
        if (modalId.startsWith('approve_submission_modal_')) {
            handler = modalHandlers.approve_submission_modal;
        } else if (modalId.startsWith('reject_submission_modal_')) {
            handler = modalHandlers.reject_submission_modal;
        } else if (modalId.startsWith('edit_bot_message_modal_')) {
            handler = modalHandlers.edit_bot_message_modal;
        } else if (modalId.startsWith('unlock_thread_modal_')) {
            handler = modalHandlers.unlock_thread_modal;
        } else if (modalId.startsWith('channel_carousel_config_')) {
            handler = modalHandlers.channel_carousel_config;
        } else if (modalId.startsWith('channel_carousel_item_')) {
            handler = modalHandlers.channel_carousel_item;
        }
    }

    if (!handler) {
        logTime(`未找到模态框处理器: ${interaction.customId}`, true);
        return;
    }

    // 使用ErrorHandler统一处理错误
    await ErrorHandler.handleInteraction(
        interaction,
        () => handler(interaction),
        `模态框${interaction.customId}`,
        { ephemeral: true }
    );
}
