import { EmbedBuilder } from 'discord.js';
import { formatPunishmentDuration } from '../utils/helper.js';

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

    // 子区分析相关embed

    /**
     * 创建符合条件子区列表的空状态embed
     * @returns {Object} 原始embed对象
     */
    static createEmptyQualifiedThreadsEmbed() {
        return {
            color: 0x0099ff,
            title: '950人以上关注的子区轮播',
            description: '[【点此查看申请标准】](https://discord.com/channels/1291925535324110879/1374952785975443466/1374954348655804477)，满足条件的创作者可以到[【申请通道】](https://discord.com/channels/1291925535324110879/1374608096076500992)提交申请。现在也允许多人合作申请频道。\n\n🔍 当前没有达到950关注的子区',
            timestamp: new Date(),
            fields: [],
        };
    }

    /**
     * 创建子区活跃度统计报告embed
     * @param {Object} statistics - 统计数据
     * @param {Array<Object>} failedOperations - 失败记录
     * @returns {Object} 原始embed对象
     */
    static createStatisticsReportEmbed(statistics, failedOperations) {
        const embed = {
            color: 0x00ff99,
            title: '子区活跃度分析报告',
            timestamp: new Date(),
            fields: [
                {
                    name: '总体统计',
                    value: [
                        `总活跃子区数: ${statistics.totalThreads}`,
                        `处理出错数量: ${statistics.processedWithErrors}`,
                        `72小时以上不活跃: ${statistics.inactiveThreads.over72h}`,
                        `48小时以上不活跃: ${statistics.inactiveThreads.over48h}`,
                        `24小时以上不活跃: ${statistics.inactiveThreads.over24h}`,
                        `符合频道主条件(≥950关注): ${statistics.qualifiedThreads.over900Members}`,
                    ].join('\n'),
                    inline: false,
                },
                {
                    name: '频道分布',
                    value: Object.values(statistics.forumDistribution)
                        .sort((a, b) => b.count - a.count)
                        .map(forum => `${forum.name}: ${forum.count}个活跃子区`)
                        .join('\n'),
                    inline: false,
                },
            ],
        };

        if (failedOperations.length > 0) {
            embed.fields.push({
                name: '处理失败记录',
                value: failedOperations
                    .slice(0, 10)
                    .map(fail => `${fail.threadName}: ${fail.operation} (${fail.error})`)
                    .join('\n'),
                inline: false,
            });
        }

        return embed;
    }

    // 身份组申请相关embed

    /**
     * 创建志愿者申请成功embed
     * @param {Array<string>} successfulServers - 成功添加身份组的服务器列表
     * @returns {Object} 原始embed对象
     */
    static createVolunteerApplicationSuccessEmbed(successfulServers) {
        return {
            color: EmbedFactory.Colors.SUCCESS,
            title: '✅ 志愿者身份组申请成功',
            description: [
                '恭喜您成功获得志愿者身份组！',
                '',
                `已在以下服务器获得志愿者身份组：`,
                successfulServers.join('\n'),
                '',
                '您将可以在[表决频道](https://discord.com/channels/1291925535324110879/1375007194365296710)参与社区重大决策的投票。',
            ].join('\n'),
            timestamp: new Date(),
            footer: {
                text: '身份组管理系统'
            }
        };
    }

    /**
     * 创建志愿者退出确认embed
     * @returns {Object} 原始embed对象
     */
    static createVolunteerExitConfirmEmbed() {
        return {
            title: '⚠️ 确认退出志愿者身份组',
            description: '您确定要退出社区服务器的志愿者身份组吗？',
            color: EmbedFactory.Colors.WARNING,
            timestamp: new Date(),
        };
    }

    /**
     * 创建志愿者退出结果embed
     * @param {boolean} success - 是否成功
     * @param {Array<string>} successfulServers - 成功操作的服务器列表（成功时）
     * @param {string} errorMessage - 错误消息（失败时）
     * @returns {Object} 原始embed对象
     */
    static createVolunteerExitResultEmbed(success, successfulServers = [], errorMessage = '') {
        if (success) {
            return {
                title: '✅ 已退出志愿者身份组',
                description: `成功在以下服务器移除志愿者身份组：\n${successfulServers.join('\n')}`,
                color: EmbedFactory.Colors.SUCCESS,
                timestamp: new Date(),
            };
        } else {
            return {
                title: '❌ 退出志愿者身份组失败',
                description: errorMessage || '操作过程中发生错误，请联系管理员',
                color: EmbedFactory.Colors.ERROR,
                timestamp: new Date(),
            };
        }
    }

    /**
     * 创建志愿者退出操作取消embed
     * @returns {Object} 原始embed对象
     */
    static createVolunteerExitCancelledEmbed() {
        return {
            title: '❌ 操作已取消',
            description: '您取消了退出志愿者身份组的操作',
            color: 0x808080,
            timestamp: new Date(),
        };
    }

    /**
     * 创建创作者身份组审核日志embed
     * @param {Object} options - 审核选项
     * @param {Object} options.user - 申请用户
     * @param {string} options.threadLink - 帖子链接
     * @param {number} options.maxReactions - 最高反应数
     * @param {string} options.serverName - 作品所在服务器名称
     * @param {boolean} options.approved - 是否通过审核
     * @returns {Object} 原始embed对象
     */
    static createCreatorRoleAuditEmbed(options) {
        const { user, threadLink, maxReactions, serverName, approved } = options;

        return {
            color: approved ? EmbedFactory.Colors.SUCCESS : EmbedFactory.Colors.ERROR,
            title: approved ? '✅ 创作者身份组申请通过' : '❌ 创作者身份组申请未通过',
            fields: [
                {
                    name: '申请者',
                    value: `<@${user.id}>`,
                    inline: true,
                },
                {
                    name: '作品链接',
                    value: threadLink,
                    inline: true,
                },
                {
                    name: '最高反应数',
                    value: `${maxReactions}`,
                    inline: true,
                },
                {
                    name: '作品所在服务器',
                    value: serverName,
                    inline: true,
                },
            ],
            timestamp: new Date(),
            footer: {
                text: '自动审核系统',
            },
        };
    }

    // 子区清理相关embed

    /**
     * 创建子区清理报告embed
     * @param {Object} result - 清理结果
     * @param {Object} options - 配置选项
     * @param {string} options.type - 清理类型: 'auto' | 'manual' | 'admin'
     * @param {boolean} options.autoCleanupEnabled - 是否启用自动清理
     * @returns {Object} 原始embed对象
     */
    static createThreadCleanupReportEmbed(result, options = {}) {
        const { type = 'manual', autoCleanupEnabled = true } = options;

        const typeConfig = {
            auto: {
                color: 0x00ff88,
                title: '🤖 自动清理完成',
                description: '系统已移除部分未发言成员，阈值继承上次设置。',
            },
            manual: {
                color: 0xffcc00,
                title: '👤 手动清理完成',
                description: `为保持子区正常运行，系统已移除部分未发言成员${autoCleanupEnabled ? '，自动清理已启用' : '，自动清理已禁用'}。`,
            },
            admin: {
                color: 0xff6600,
                title: '🛡️ 管理员清理完成',
                description: `为保持子区正常运行，系统已移除部分未发言成员${autoCleanupEnabled ? '，自动清理已启用' : '，自动清理已禁用'}。`,
            }
        };

        const config = typeConfig[type];

        return {
            color: config.color,
            title: config.title,
            description: [
                config.description,
                `被移除的成员可以随时重新加入讨论。`,
            ].join('\n'),
            fields: [
                {
                    name: '统计信息',
                    value: [
                        `原始人数: ${result.originalCount}`,
                        `移除人数: ${result.removedCount}`,
                        result.lowActivityCount > 0 ? `(包含 ${result.lowActivityCount} 个低活跃度成员)` : '',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                    inline: false,
                },
            ],
            timestamp: new Date(),
        };
    }

    /**
     * 创建管理日志清理报告embed
     * @param {Object} result - 清理结果
     * @param {Object} options - 配置选项
     * @param {string} options.type - 清理类型: 'auto' | 'manual' | 'admin'
     * @param {Object} options.executor - 执行者信息（手动/管理员清理时）
     * @returns {Object} 原始embed对象
     */
    static createLogCleanupReportEmbed(result, options = {}) {
        const { type = 'manual', executor } = options;

        const typeConfig = {
            auto: {
                color: 0x00ff88,
                title: '🤖 自动清理报告',
                footer: '论坛自动化系统'
            },
            manual: {
                color: 0xffcc00,
                title: '👤 用户清理报告',
                footer: executor ? `用户清理 · 执行者: ${executor.tag}` : '论坛管理系统'
            },
            admin: {
                color: 0xff6600,
                title: '🛡️ 管理员清理报告',
                footer: executor ? `管理员清理 · 执行者: ${executor.tag}` : '论坛管理系统'
            }
        };

        const config = typeConfig[type];

        return {
            color: config.color,
            title: config.title,
            fields: [
                {
                    name: result.name,
                    value: [
                        `[跳转到子区](${result.url})`,
                        `原始人数: ${result.originalCount}`,
                        `移除人数: ${result.removedCount}`,
                        result.lowActivityCount > 0 ? `(包含 ${result.lowActivityCount} 个低活跃度成员)` : '',
                    ]
                        .filter(Boolean)
                        .join('\n'),
                    inline: false,
                },
            ],
            timestamp: new Date(),
            footer: { text: config.footer },
        };
    }

    // 处罚系统相关embed

    /**
     * 获取处罚类型的配置信息
     * @param {string} type - 处罚类型
     * @returns {Object} 配置对象
     */
    static getPunishmentConfig(type) {
        const configs = {
            ban: {
                color: 0xff0000,      // 红色 - 永封
                typeText: '永封'
            },
            softban: {
                color: 0xff9900,      // 橙色 - 软封锁
                typeText: '移出服务器'
            },
            mute: {
                color: 0xff6600,      // 深橙色 - 禁言
                typeText: '禁言'
            },
            warning: {
                color: 0xffcc00,      // 黄色 - 警告
                typeText: '警告'
            }
        };

        return configs[type] || {
            color: 0xff0000,
            typeText: type
        };
    }

    /**
     * 获取用户头像URL
     * @param {Object} user - 用户对象
     * @returns {string} 头像URL
     */
    static getUserAvatarURL(user) {
        return user.displayAvatarURL({
            dynamic: true,
            size: 64,
        }) || user.defaultAvatarURL;
    }

    /**
     * 获取处罚期限描述文本
     * @param {Object} punishment - 处罚对象
     * @returns {string} 期限描述
     */
    static getPunishmentDurationText(punishment) {
        switch (punishment.type) {
            case 'ban':
                return '永久';
            case 'softban':
                return '移出服务器（消息已删除）';
            case 'mute':
                return punishment.duration > 0 ? formatPunishmentDuration(punishment.duration) : '永久';
            case 'warning':
                return punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '永久';
            default:
                return '未知';
        }
    }

    /**
     * 创建管理日志处罚通知embed
     * @param {Object} punishment - 处罚数据库记录
     * @param {Object} target - 目标用户对象
     * @returns {Object} 原始embed对象
     */
    static createModLogPunishmentEmbed(punishment, target) {
        const config = EmbedFactory.getPunishmentConfig(punishment.type);
        const targetAvatarURL = EmbedFactory.getUserAvatarURL(target);

        const embed = {
            color: config.color,
            title: `${target.username} 已被${config.typeText}`,
            thumbnail: {
                url: targetAvatarURL,
            },
            fields: [
                {
                    name: '处罚对象',
                    value: `<@${target.id}>`,
                    inline: true,
                },
                {
                    name: '处罚期限',
                    value: EmbedFactory.getPunishmentDurationText(punishment),
                    inline: true,
                },
                {
                    name: '处罚理由',
                    value: punishment.reason || '未提供原因',
                },
            ],
            timestamp: new Date(),
            footer: { text: `处罚ID: ${punishment.id}` },
        };

        // 根据处罚类型添加特定信息
        if ((punishment.type === 'mute' || punishment.type === 'softban') && punishment.warningDuration) {
            embed.fields.push({
                name: '附加警告',
                value: formatPunishmentDuration(punishment.warningDuration),
                inline: true,
            });
        }

        // 如果有投票信息，添加链接
        if (punishment.voteInfo) {
            const voteLink = `https://discord.com/channels/${punishment.voteInfo.guildId}/${punishment.voteInfo.channelId}/${punishment.voteInfo.messageId}`;
            embed.fields.push({
                name: '议会投票',
                value: `[点击查看投票结果](${voteLink})`,
                inline: true,
            });
        }

        return embed;
    }

    /**
     * 创建频道处罚通知embed
     * @param {Object} punishment - 处罚数据库记录
     * @param {Object} target - 目标用户对象
     * @returns {Object} 原始embed对象
     */
    static createChannelPunishmentEmbed(punishment, target) {
        const config = EmbedFactory.getPunishmentConfig(punishment.type);
        const targetAvatarURL = EmbedFactory.getUserAvatarURL(target);

        // 构建描述内容
        let description = `<@${target.id}> 已被${config.typeText}`;

        switch (punishment.type) {
            case 'ban':
                description = `<@${target.id}> 已被永封`;
                break;
            case 'softban':
                description = `<@${target.id}> 已被移出服务器，且近期发送的消息已删除`;
                if (punishment.warningDuration) {
                    description += `，附加警告${formatPunishmentDuration(punishment.warningDuration)}`;
                }
                break;
            case 'mute':
                const muteDuration = punishment.duration > 0 ? formatPunishmentDuration(punishment.duration) : '永久';
                description = `<@${target.id}> 已被禁言${muteDuration}`;
                if (punishment.warningDuration) {
                    description += `，且附加警告${formatPunishmentDuration(punishment.warningDuration)}`;
                }
                break;
            case 'warning':
                const warningDuration = punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '永久';
                description = `<@${target.id}> 已被警告${warningDuration}`;
                break;
        }

        description += `。理由：${punishment.reason || '未提供原因'}`;

        return {
            color: config.color,
            title: `${config.typeText}处罚已执行`,
            description: description,
            thumbnail: {
                url: targetAvatarURL,
            },
            footer: {
                text: `处罚ID: ${punishment.id} | 如有异议，请联系服务器主或在任管理员。`,
            },
            timestamp: new Date(),
        };
    }

    /**
     * 创建处罚私信通知embed
     * @param {Object} punishment - 处罚数据库记录
     * @param {string} punishment.type - 处罚类型 (ban/mute/softban/warning)
     * @returns {Object} 原始embed对象
     */
    static createPunishmentDMEmbed(punishment) {
        const config = EmbedFactory.getPunishmentConfig(punishment.type);
        const baseDescription = [
            `您已在旅程ΟΡΙΖΟΝΤΑΣ被${config.typeText}：`,
            `- ${config.typeText === '移出服务器' ? '移出服务器原因' : config.typeText + '原因'}：${punishment.reason || '未提供原因'}`,
        ];

        // 根据处罚类型添加特定信息
        switch (punishment.type) {
            case 'ban':
                // 永封不需要额外信息
                break;

            case 'softban':
                baseDescription.push('- 您7天内发送在服务器内的消息已被删除');
                baseDescription.push('- 您可以通过以下邀请链接重新加入服务器');
                baseDescription.push('https://discord.gg/elysianhorizon');

                if (punishment.warningDuration) {
                    baseDescription.splice(3, 0, `- 附加警告：${formatPunishmentDuration(punishment.warningDuration)}`);
                }
                break;

            case 'mute':
                baseDescription.splice(1, 0, `- 禁言期限：${formatPunishmentDuration(punishment.duration)}`);
                if (punishment.warningDuration) {
                    baseDescription.splice(2, 0, `- 附加警告：${formatPunishmentDuration(punishment.warningDuration)}`);
                }
                break;

            case 'warning':
                baseDescription.splice(1, 0, `- 警告时长：${punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '永久'}`);
                baseDescription.push('- 请遵守服务器规则，避免进一步违规');
                break;
        }

        return {
            color: config.color,
            title: `您已在旅程ΟΡΙΖΟΝΤΑΣ被${config.typeText}`,
            description: baseDescription.join('\n'),
            footer: {
                text: `如有异议，请联系服务器主或在任管理员。`,
            },
            timestamp: new Date(),
        };
    }

    /**
     * 创建处罚撤销私信通知embed
     * @param {Object} punishment - 处罚数据库记录
     * @param {string} reason - 撤销原因
     * @returns {Object} 原始embed对象
     */
    static createPunishmentRevokeDMEmbed(punishment, reason) {
        const config = EmbedFactory.getPunishmentConfig(punishment.type);

        return {
            color: EmbedFactory.Colors.SUCCESS,
            title: `您的${config.typeText}处罚已被撤销`,
            description: [
                `您的${config.typeText}处罚已被管理员撤销。`,
                '',
                '**处罚详情**',
                `- 处罚ID：${punishment.id}`,
                `- 原处罚原因：${punishment.reason}`,
                `- 撤销原因：${reason}`,
            ].join('\n'),
            timestamp: new Date(),
            footer: {
                text: '如有疑问，请联系服务器主或在任管理员。',
            }
        };
    }

    /**
     * 创建处罚撤销管理日志embed
     * @param {Object} punishment - 处罚数据库记录
     * @param {Object} target - 目标用户对象
     * @param {string} reason - 撤销原因
     * @param {Array<string>} successfulServers - 成功操作的服务器列表
     * @param {Array<Object>} failedServers - 失败操作的服务器列表
     * @returns {Object} 原始embed对象
     */
    static createPunishmentRevokeLogEmbed(punishment, target, reason, successfulServers = [], failedServers = []) {
        const config = EmbedFactory.getPunishmentConfig(punishment.type);
        const targetAvatarURL = EmbedFactory.getUserAvatarURL(target);

        const embed = {
            color: EmbedFactory.Colors.SUCCESS,
            title: `${target.username} 的${config.typeText}处罚已被撤销`,
            thumbnail: {
                url: targetAvatarURL,
            },
            fields: [
                {
                    name: '处罚对象',
                    value: `<@${target.id}>`,
                    inline: true,
                },
                {
                    name: '原处罚类型',
                    value: config.typeText,
                    inline: true,
                },
                {
                    name: '撤销原因',
                    value: reason,
                },
            ],
            timestamp: new Date(),
            footer: { text: `处罚ID: ${punishment.id}` },
        };

        if (successfulServers.length > 0) {
            embed.fields.push({
                name: '成功服务器',
                value: successfulServers.join(', '),
            });
        }

        if (failedServers.length > 0) {
            embed.fields.push({
                name: '失败服务器',
                value: failedServers.map(s => s.name).join(', '),
            });
        }

        return embed;
    }

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
