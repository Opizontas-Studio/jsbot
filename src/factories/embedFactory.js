import { EmbedBuilder } from 'discord.js';

/**
 * Embed工厂类
 * 负责创建各种Discord Embed对象
 */
export class EmbedFactory {

    // 意见信箱相关embed

    /**
     * 创建意见信箱入口消息的embed
     * @returns {EmbedBuilder} 构建好的embed
     */
    static createOpinionMailboxEmbed() {
        return new EmbedBuilder()
            .setTitle('📮 社区意见信箱')
            .setDescription(
                [
                    '点击下方按钮，您可以向社区提交意见或建议：',
                    '',
                    '**提交要求：**',
                    '- 意见内容应当具体、建设性',
                    '- 可以是对社区的反馈或倡议',
                    '',
                    '管理组会查看并尽快处理您的意见',
                ].join('\n'),
            )
            .setColor(0x00aaff);
    }

    /**
     * 创建投稿审核消息的embed
     * @param {Object} user - 提交用户
     * @param {string} title - 投稿标题
     * @param {string} content - 投稿内容
     * @param {string} titlePrefix - 标题前缀
     * @param {number} color - embed颜色
     * @returns {Object} 原始embed对象
     */
    static createSubmissionReviewEmbed(user, title, content, titlePrefix, color) {
        return {
            color: color,
            title: `${titlePrefix}${title}`,
            description: content,
            author: {
                name: user.tag,
                icon_url: user.displayAvatarURL(),
            },
            timestamp: new Date(),
            footer: {
                text: '等待管理员审定'
            }
        };
    }

    /**
     * 创建私聊反馈消息的embed
     * @param {boolean} isApproved - 是否被批准
     * @param {string} submissionTitle - 投稿标题
     * @param {string} adminReply - 管理员回复
     * @returns {Object} 原始embed对象
     */
    static createDMFeedbackEmbed(isApproved, submissionTitle, adminReply) {
        return {
            color: isApproved ? 0x5fa85f : 0xb85c5c,
            title: '📮 意见信箱反馈',
            description: [
                `**对您的投稿：${submissionTitle}**`,
                `**管理组回复为：**`,
                adminReply
            ].join('\n'),
            timestamp: new Date(),
            footer: {
                text: '感谢您投稿的社区意见',
            }
        };
    }

    /**
     * 创建更新投稿审核状态的embed
     * @param {Object} originalEmbed - 原始embed
     * @param {boolean} isApproved - 是否被批准
     * @returns {Object} 更新后的embed对象
     */
    static createUpdatedSubmissionEmbed(originalEmbed, isApproved) {
        return {
            ...originalEmbed.toJSON(),
            author: isApproved ? undefined : originalEmbed.author, // 批准时移除作者信息，拒绝时保留
            footer: {
                text: isApproved ? '审定有效' : '审定无效'
            }
        };
    }

    // 监控系统相关embed

    /**
     * 创建系统状态监控embed
     * @param {Object} statusData - 状态数据
     * @param {number} statusData.ping - 网络延迟
     * @param {string} statusData.connectionStatus - 连接状态
     * @param {string} statusData.uptime - 运行时间
     * @param {Object} statusData.queueStats - 队列统计信息
     * @returns {EmbedBuilder} 构建好的embed
     */
    static createSystemStatusEmbed(statusData) {
        const { ping, connectionStatus, uptime, queueStats } = statusData;

        return new EmbedBuilder()
            .setColor(EmbedFactory.Colors.INFO)
            .setTitle('系统运行状态')
            .setFields(
                {
                    name: '网络延迟',
                    value: ping === -1 ? '无法获取' : `${ping}ms`,
                    inline: true,
                },
                {
                    name: 'WebSocket状态',
                    value: connectionStatus,
                    inline: true,
                },
                {
                    name: '运行时间',
                    value: uptime,
                    inline: true,
                },
                {
                    name: '任务统计',
                    value: [
                        `📥 等待处理: ${queueStats.queueLength}`,
                        `⚡ 正在处理: ${queueStats.currentProcessing}`,
                        `✅ 已完成: ${queueStats.processed}`,
                        `❌ 失败: ${queueStats.failed}`,
                    ].join('\n'),
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({ text: '系统监控' });
    }

    /**
     * 常用颜色常量
     */
    static Colors = {
        SUCCESS: 0x5fa85f,
        ERROR: 0xb85c5c,
        INFO: 0x00aaff,
        WARNING: 0xffcc00,
        PRIMARY: 0x5865f2
    };

    /**
     * 常用emoji前缀
     */
    static Emojis = {
        MAILBOX: '📮',
        SUCCESS: '✅',
        ERROR: '❌',
        INFO: 'ℹ️',
        WARNING: '⚠️',
        OPINION: '💬'
    };
}
