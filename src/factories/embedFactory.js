import { EmbedBuilder } from 'discord.js';
import { formatPunishmentDuration } from '../utils/helper.js';

/**
 * Embed工厂类
 * 负责创建各种Discord Embed对象
 */
export class EmbedFactory {

    /**
     * 常用颜色常量
     */
    static Colors = {
        SUCCESS: 0x5fa85f,
        ERROR: 0xb85c5c,
        INFO: 0x00aaff,
        WARNING: 0xffcc00,
        PRIMARY: 0x5865f2,
        DANGER: 0xff0000,
        TIMEOUT: 0x808080
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
        const { ping, connectionStatus, uptime, queueStats, pgSyncStats } = statusData;

        const fields = [
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
            }
        ];

        // 添加 PG 同步统计（如果启用）
        if (pgSyncStats) {
            fields.push({
                name: '📊 数据同步状态',
                value: [
                    `总帖子: ${pgSyncStats.totalThreads}`,
                    `队列: 高${pgSyncStats.highPriority} 中${pgSyncStats.mediumPriority} 低${pgSyncStats.lowPriority}`,
                    `今日同步: ${pgSyncStats.todaySynced}次`,
                    `错误: ${pgSyncStats.errorCount}次`
                ].join('\n'),
                inline: false
            });
        }

        return new EmbedBuilder()
            .setColor(EmbedFactory.Colors.INFO)
            .setTitle('系统运行状态')
            .setFields(fields)
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
     * @param {boolean} options.isAutoGrant - 是否为自动发放
     * @returns {Object} 原始embed对象
     */
    static createCreatorRoleAuditEmbed(options) {
        const { user, threadLink, maxReactions, serverName, approved, isAutoGrant = false } = options;

        const titlePrefix = isAutoGrant ? '🤖 [自动发放] ' : '';
        const footerText = isAutoGrant ? '自动发放系统' : '自动审核系统';

        return {
            color: approved ? EmbedFactory.Colors.SUCCESS : EmbedFactory.Colors.ERROR,
            title: approved ? `${titlePrefix}✅ 创作者身份组申请通过` : '❌ 创作者身份组申请未通过',
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
                text: footerText,
            },
        };
    }

    /**
     * 创建创作者身份组放弃成功embed
     * @param {Array<string>} successfulServers - 成功移除身份组的服务器列表
     * @returns {Object} 原始embed对象
     */
    static createCreatorRoleOptOutSuccessEmbed(successfulServers) {
        return {
            color: EmbedFactory.Colors.SUCCESS,
            title: '✅ 已放弃创作者身份组',
            description: [
                '您已成功放弃创作者身份组。',
                '',
                `已在以下服务器移除创作者身份组：`,
                successfulServers.join('\n'),
                '',
                '💡 **重要提示：**',
                '• 您的作品帖子将不会再被自动授予创作者身份组',
                '• 如果您改变主意，可以随时通过申请按钮重新申请',
            ].join('\n'),
            timestamp: new Date(),
            footer: {
                text: '身份组管理'
            }
        };
    }

    /**
     * 创建创作者身份组申请成功的欢迎embed
     * @param {Array<string>} syncedServers - 同步成功的服务器列表
     * @param {number} totalCreators - 当前创作者总数
     * @returns {EmbedBuilder} 构建好的embed
     */
    static createCreatorRoleSuccessEmbed(syncedServers, totalCreators = 0) {
        const syncInfo = syncedServers.length > 1
            ? `\n\n✨ **已同步至：**${syncedServers.join('、')}`
            : '';

        const creatorNumberInfo = totalCreators > 0
            ? `\n\n🎊 **您是第 ${totalCreators} 位创作者！**`
            : '';

        return new EmbedBuilder()
            .setTitle('🎨 欢迎加入旅程社区创作者的大家庭！')
            .setDescription(
                [
                    creatorNumberInfo,
                    '',
                    '### 📢 作品更新的通知',
                    '您现在可以使用 `/发送通知` 命令通知您的作品的关注者自己有更新哦。',
                    '',
                    '### 🎭 暖暖装扮身份组',
                    '现在还可以到 [旅程暖暖](https://discord.com/channels/1291925535324110879/1390230760077791232) 切换装扮身份组啦。',
                    '',
                    '### 📚 帖子管理指南',
                    '最后记得到 [BOT说明书](https://discord.com/channels/1291925535324110879/1338165171432194118) 学习一下如何管理自己的帖子！',
                ].join('\n')
            )
            .setColor(EmbedFactory.Colors.SUCCESS)
            .setTimestamp();
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
            extension: 'png',
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
                return '消息已删除';
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
            case 'mute': {
                const muteDuration = punishment.duration > 0 ? formatPunishmentDuration(punishment.duration) : '永久';
                description = `<@${target.id}> 已被禁言${muteDuration}`;
                if (punishment.warningDuration) {
                    description += `，且附加警告${formatPunishmentDuration(punishment.warningDuration)}`;
                }
                break;
            }
            case 'warning': {
                const warningDuration = punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '永久';
                description = `<@${target.id}> 已被警告${warningDuration}`;
                break;
            }
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
                    baseDescription.splice(2, 0, `- 附加警告：${formatPunishmentDuration(punishment.warningDuration)}`);
                }
                break;

            case 'mute':
                baseDescription.splice(0, 0, `- 禁言期限：${formatPunishmentDuration(punishment.duration)}`);
                if (punishment.warningDuration) {
                    baseDescription.splice(1, 0, `- 附加警告：${formatPunishmentDuration(punishment.warningDuration)}`);
                }
                break;

            case 'warning':
                baseDescription.splice(0, 0, `- 警告时长：${punishment.warningDuration ? formatPunishmentDuration(punishment.warningDuration) : '永久'}`);
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
            title: `您在旅程ΟΡΙΖΟΝΤΑΣ的${config.typeText}处罚已被撤销`,
            description: [
                `- 原${config.typeText === '移出服务器' ? '移出服务器原因' : config.typeText + '原因'}：${punishment.reason || '未提供原因'}`,
                `- 撤销原因：${reason}`,
            ].join('\n'),
            timestamp: new Date(),
        };
    }

    /**
     * 创建处罚确认请求embed
     * @param {Object} options - 配置选项
     * @param {string} options.punishmentType - 处罚类型
     * @param {Object} options.target - 目标用户对象
     * @param {Object} options.submitter - 提交者对象
     * @param {string} options.reason - 处罚原因
     * @param {Object} options.punishmentData - 处罚详细数据
     * @returns {Object} 原始embed对象
     */
    static createPunishmentConfirmationEmbed({ punishmentType, target, submitter, reason, punishmentData }) {
        const config = EmbedFactory.getPunishmentConfig(punishmentType);
        const targetAvatarURL = EmbedFactory.getUserAvatarURL(target);

        // 构建处罚详情
        const fields = [
            {
                name: '提交人',
                value: `<@${submitter.id}> (${submitter.tag})`,
                inline: true,
            },
            {
                name: '目标用户',
                value: `<@${target.id}> (${target.tag})`,
                inline: false,
            },
            {
                name: '处罚原因',
                value: reason,
                inline: false,
            }
        ];

        // 根据处罚类型添加特定字段
        switch (punishmentType) {
            case 'ban':
                fields.push({
                    name: '消息处理',
                    value: punishmentData.keepMessages ? '保留用户消息' : '删除7天内消息',
                    inline: true,
                });
                break;

            case 'mute':
                fields.push({
                    name: '禁言时长',
                    value: formatPunishmentDuration(punishmentData.duration),
                    inline: true,
                });
                if (punishmentData.warningDuration) {
                    fields.push({
                        name: '附加警告时长',
                        value: formatPunishmentDuration(punishmentData.warningDuration),
                        inline: true,
                    });
                }
                break;

            case 'softban':
                if (punishmentData.warningDuration) {
                    fields.push({
                        name: '警告时长',
                        value: formatPunishmentDuration(punishmentData.warningDuration),
                        inline: true,
                    });
                }
                break;

            case 'warning':
                fields.push({
                    name: '警告时长',
                    value: formatPunishmentDuration(punishmentData.warningDuration),
                    inline: true,
                });
                break;
        }

        // 添加注意事项
        let description = '**⚠️ 注意：**\n';
        description += '- 请确认已保存了截图证据\n';
        description += '- 请确认处罚理由有法可依\n';

        // 根据处罚类型添加特殊提示
        switch (punishmentType) {
            case 'ban':
                description += '⚠️ **永封为最严厉处罚，必须由他人确认！**';
                break;
            case 'softban':
                description += '⚠️ **软封锁需要他人确认，或提交者等待1分钟后自行确认。**';
                break;
            case 'mute':
            case 'warning':
                description += 'ℹ️ 有权限的管理人员可以即时确认此处罚。';
                break;
        }

        return {
            color: config.color,
            title: `${config.typeText}处罚确认`,
            description,
            thumbnail: {
                url: targetAvatarURL,
            },
            fields,
            timestamp: new Date(),
            footer: {
                text: '请在30分钟内确认或驳回'
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

    // 解锁申请相关embed

    /**
     * 创建解锁申请审核消息的embed
     * @param {Object} user - 申请用户
     * @param {string} threadUrl - 子区链接
     * @param {string} threadName - 子区名称
     * @param {string} reason - 解锁理由
     * @returns {Object} 原始embed对象
     */
    static createUnlockRequestEmbed(user, threadUrl, threadName, reason) {
        return {
            color: 0xffa500, // 橙色
            title: '🔓 帖子解锁申请',
            description: [
                `**申请者：** <@${user.id}>`,
                `**帖子：** [${threadName}](${threadUrl})`,
                '',
                '**解锁理由：**',
                reason
            ].join('\n'),
            author: {
                name: user.tag,
                icon_url: user.displayAvatarURL(),
            },
            timestamp: new Date(),
            footer: {
                text: '等待管理员审核'
            }
        };
    }

    /**
     * 创建解锁申请反馈embed
     * @param {boolean} isApproved - 是否批准
     * @param {string} threadName - 子区名称
     * @param {string} threadUrl - 子区链接
     * @param {string} [adminNote] - 管理员备注（可选）
     * @returns {Object} 原始embed对象
     */
    static createUnlockFeedbackEmbed(isApproved, threadName, threadUrl, adminNote = null) {
        return {
            color: isApproved ? EmbedFactory.Colors.SUCCESS : EmbedFactory.Colors.ERROR,
            title: isApproved ? '✅ 解锁申请已批准' : '❌ 解锁申请被拒绝',
            description: [
                `**子区：** [${threadName}](${threadUrl})`,
                '',
                isApproved ? '您的帖子已成功解锁。' : '您的解锁申请未获批准。',
                adminNote ? `\n**管理员说明：** ${adminNote}` : ''
            ].filter(Boolean).join('\n'),
            timestamp: new Date(),
            footer: {
                text: '自助解锁系统'
            }
        };
    }

    // 自助管理相关embed

    /**
     * 创建删除帖子确认embed
     * @param {Object} thread - 帖子对象
     * @returns {Object} embed配置对象
     */
    static createDeleteThreadConfirmEmbed(thread) {
        return {
            color: EmbedFactory.Colors.DANGER,
            title: '⚠️ 删除确认',
            description: `你确定要删除帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：此操作不可撤销！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}`,
        };
    }

    /**
     * 创建锁定帖子确认embed
     * @param {Object} thread - 帖子对象
     * @param {string} reason - 锁定原因
     * @returns {Object} embed配置对象
     */
    static createLockThreadConfirmEmbed(thread, reason) {
        return {
            color: EmbedFactory.Colors.DANGER,
            title: '⚠️ 锁定确认',
            description: `你确定要锁定并关闭帖子 "${thread.name}" 吗？\n\n**⚠️ 警告：锁定后其他人将无法回复！**\n\n创建时间：${thread.createdAt.toLocaleString()}\n回复数量：${thread.messageCount}\n锁定原因：${reason || '未提供'}`,
        };
    }

    /**
     * 创建清理不活跃用户确认embed
     * @param {Object} thread - 帖子对象
     * @param {number} memberCount - 当前成员数
     * @param {number} threshold - 清理阈值
     * @param {boolean} enableAutoCleanup - 是否启用自动清理
     * @returns {Object} embed配置对象
     */
    static createCleanInactiveUsersConfirmEmbed(thread, memberCount, threshold, enableAutoCleanup) {
        return {
            color: EmbedFactory.Colors.DANGER,
            title: '⚠️ 清理确认',
            description: [
                `你确定要清理帖子 "${thread.name}" 中的不活跃用户吗？`,
                '',
                `⚠️ 此操作将：至少清理：${memberCount - threshold} 人`,
                '- 优先移除未发言成员，若不足则会移除上次发言较早的成员',
                '- 被移除的成员可以随时重新加入讨论',
                '',
                `🤖 自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                enableAutoCleanup
                    ? '- 系统将在帖子达到990人时自动清理至设定阈值'
                    : '- 系统将不会对此帖子进行自动清理',
            ].join('\n'),
        };
    }

    /**
     * 创建删除用户消息确认embed
     * @param {Object} targetUser - 目标用户
     * @param {string} threadName - 帖子名称
     * @returns {Object} embed配置对象
     */
    static createDeleteUserMessagesConfirmEmbed(targetUser, threadName) {
        return {
            color: EmbedFactory.Colors.DANGER,
            title: '⚠️ 删除确认',
            description: [
                `你确定要删除用户 **${targetUser.tag}** 在帖子 "${threadName}" 中的所有消息吗？`,
                '',
                '**⚠️ 警告：**',
                '- 此操作不可撤销，将删除该用户的所有消息并将其移出子区。',
                '- 如果帖子消息数量很多，此操作可能需要较长时间，最大扫描上限为3000条。'
            ].join('\n'),
        };
    }

    /**
     * 创建操作超时embed
     * @param {string} operationName - 操作名称
     * @returns {Object} embed配置对象
     */
    static createOperationTimeoutEmbed(operationName) {
        return {
            color: EmbedFactory.Colors.TIMEOUT,
            title: '❌ 确认已超时',
            description: `${operationName}操作已超时。如需继续请重新执行命令。`,
        };
    }

    /**
     * 创建清理不活跃用户的阈值提醒embed
     * @param {number} memberCount - 当前成员数
     * @param {number} threshold - 阈值
     * @param {boolean} enableAutoCleanup - 是否启用自动清理
     * @returns {Object} embed配置对象
     */
    static createCleanupThresholdWarningEmbed(memberCount, threshold, enableAutoCleanup) {
        return {
            color: EmbedFactory.Colors.WARNING,
            title: '⚠️ 阈值提醒',
            description: [
                `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`,
                `自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                '此外，当前阈值大于990，因此不会应用到自动清理配置中',
                enableAutoCleanup
                    ? '- 系统将在帖子达到990人时自动清理'
                    : '- 系统将不会对此帖子进行自动清理',
            ].join('\n'),
        };
    }

    /**
     * 创建无需清理embed
     * @param {number} memberCount - 当前成员数
     * @param {number} threshold - 阈值
     * @param {boolean} enableAutoCleanup - 是否启用自动清理
     * @returns {Object} embed配置对象
     */
    static createNoCleanupNeededEmbed(memberCount, threshold, enableAutoCleanup) {
        return {
            color: EmbedFactory.Colors.TIMEOUT,
            title: '❌ 无需清理',
            description: [
                `当前帖子人数(${memberCount})未达到清理阈值(${threshold})`,
                `自动清理：${enableAutoCleanup ? '启用' : '禁用'}`,
                enableAutoCleanup
                    ? `- 系统将在帖子达到990人时自动清理至当前设定的阈值(${threshold})`
                    : '- 系统将不会对此帖子进行自动清理',
            ].join('\n'),
        };
    }

    /**
     * 创建清理任务提交成功embed
     * @param {boolean} enableAutoCleanup - 是否启用自动清理
     * @returns {Object} embed配置对象
     */
    static createCleanupTaskSubmittedEmbed(enableAutoCleanup) {
        return {
            color: EmbedFactory.Colors.SUCCESS,
            title: '✅ 任务已提交成功',
            description: [
                '清理任务已添加到后台队列，由于DC API限制，初次执行耗时可能很长，且开始不会有反馈，请耐心等候。',
                `**🤖 自动清理状态：${enableAutoCleanup ? '已启用' : '已禁用'}**`,
                enableAutoCleanup
                    ? '• 系统将在帖子达到990人时自动清理至你设定的阈值'
                    : '• 系统将不会对此帖子进行自动清理',
            ].join('\n'),
            timestamp: new Date()
        };
    }

    // 帖子拉黑相关embed

    /**
     * 创建拉黑违规提示embed
     * @param {Object} user - 违规用户对象
     * @param {Object} thread - 帖子对象
     * @param {string} muteDuration - 禁言时长文本
     * @param {boolean} isRepeatViolation - 是否为重复违规
     * @returns {Object} embed配置对象
     */
    static createBlacklistViolationEmbed(user, thread, muteDuration, isRepeatViolation) {
        if (isRepeatViolation) {
            return {
                color: EmbedFactory.Colors.DANGER,
                description: `<@${user.id}> 已被拉黑，并因在当前帖子多次尝试发送消息被禁言 ${muteDuration}`,
                timestamp: new Date(),
                footer: {
                text: '自助管理系统'
            }
            };
        } else {
            return {
                color: EmbedFactory.Colors.WARNING,
                description: `<@${user.id}> 已被拉黑，再次在当前帖子发送消息可能会被长期禁言`,
                timestamp: new Date(),
                footer: {
                text: '自助管理系统'
            }
            };
        }
    }

    /**
     * 创建拉黑违规管理通知embed
     * @param {Object} user - 违规用户对象
     * @param {Object} thread - 帖子对象
     * @param {string} muteDuration - 禁言时长文本
     * @returns {Object} embed配置对象
     */
    static createBlacklistAdminNotificationEmbed(user, thread, muteDuration) {
        const threadUrl = `https://discord.com/channels/${thread.guild.id}/${thread.id}`;

        return {
            color: EmbedFactory.Colors.WARNING,
            title: '⚠️ 拉黑用户屡犯警告',
            description: [
                `**用户：** <@${user.id}> (${user.tag})`,
                `**帖子：** [${thread.name}](${threadUrl})`,
                '',
                `该用户在被拉黑后多次在当前帖子尝试发送消息。`,
                `已自动删除消息并禁言 ${muteDuration}。`
            ].join('\n'),
            timestamp: new Date(),
            footer: {
                text: '自助管理系统'
            }
        };
    }
}
