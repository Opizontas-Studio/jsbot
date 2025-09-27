import { readFileSync } from 'fs';
import { join } from 'path';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import { calculatePunishmentDuration } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import PunishmentService from './punishmentService.js';
import { handleDebateRolesAfterVote, manageRolesByGroups } from './roleApplication.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

class VoteService {
    /**
     * 为议事流程创建投票
     * @param {Object} process - 议事流程记录
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} options - 创建选项
     * @param {string} options.messageId - 投票消息ID
     * @param {string} options.threadId - 辩诉帖ID
     * @param {Object} client - Discord客户端
     * @returns {Promise<Object>} 创建的投票记录
     */
    static async createVoteForProcess(process, guildConfig, options, client) {
        try {
            // 验证配置
            if (!guildConfig?.courtSystem?.enabled) {
                throw new Error('此服务器未启用议事系统');
            }

            if (!guildConfig.courtSystem.voteDuration) {
                throw new Error('投票时间配置无效');
            }

            const { type, targetId, executorId, details } = process;
            const totalVoters = guildConfig.roleApplication?.senatorRoleId ? await this._getSenatorsCount(client) : 0;

            if (totalVoters === 0) {
                throw new Error('无法获取议员总数或议员总数为0');
            }

            let redSide, blueSide, voteDetails;
            if (type === 'appeal') {
                // 获取处罚记录以确定处罚类型
                const punishment = await PunishmentModel.getPunishmentById(parseInt(details.punishmentId));
                if (!punishment) {
                    throw new Error('无法获取相关处罚记录');
                }

                redSide = `解除对 <@${targetId}> 的处罚`;
                blueSide = '维持原判';

                // 构建投票详情
                voteDetails = {
                    targetId,
                    executorId,
                    punishmentId: details.punishmentId,
                    punishmentType: punishment.type,
                    appealContent: details.appealContent,
                    // 添加原处罚的关键信息
                    originalReason: punishment.reason,
                    originalDuration: punishment.duration,
                    originalWarningDuration: punishment.warningDuration,
                };
            } else if (type.startsWith('court_')) {
                let punishType;
                if (type === 'court_ban') {
                    punishType = '永封';
                } else if (type === 'court_impeach') {
                    punishType = '弹劾';
                } else {
                    punishType = '禁言';
                }

                redSide =
                    type === 'court_impeach' ? `弹劾管理员 <@${targetId}>` : `对 <@${targetId}> 执行${punishType}`;
                blueSide = '驳回处罚申请';

                // 构建投票详情
                voteDetails = {
                    ...details,
                    targetId,
                    executorId,
                    punishmentType: type === 'court_impeach' ? 'impeach' : type === 'court_ban' ? 'ban' : 'mute',
                    reason: details.reason || '无原因',
                    muteTime: details.muteTime,
                    warningTime: details.warningTime,
                    keepMessages: details.keepMessages ?? true,
                    revokeRoleId: details.revokeRoleId,
                };
            } else {
                throw new Error('不支持的议事类型');
            }

            const now = Date.now();
            const voteDuration = guildConfig.courtSystem.voteDuration;

            const result = await VoteModel.createVote({
                processId: process.id,
                type: type,
                redSide,
                blueSide,
                totalVoters,
                messageId: options.messageId,
                threadId: options.threadId,
                details: voteDetails,
                startTime: now,
                endTime: now + voteDuration,
            });

            // 获取目标用户和执行者信息用于日志
            const [target, executor] = await Promise.all([
                client.users.fetch(targetId).catch(() => null),
                client.users.fetch(executorId).catch(() => null),
            ]);

            // 投票创建日志
            logTime(
                `创建投票 [ID: ${result.id}] - 类型: ${process.type}, 目标: ${target?.tag || '未知用户'}, 发起人: ${
                    executor?.tag || '未知用户'
                }, 结束: ${voteDuration / 1000}秒后`,
            );
            logTime(
                `投票详情 [ID: ${result.id}] - 红方: ${redSide}, 蓝方: ${blueSide}`,
            );

            return result;
        } catch (error) {
            logTime(`创建投票失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 处理投票操作
     * @param {Object} vote - 投票记录
     * @param {string} userId - 投票用户ID
     * @param {string} choice - 投票选择 (red/blue)
     * @returns {Promise<{vote: Object, message: string}>} 更新后的投票记录和提示消息
     */
    static async handleVote(vote, userId, choice) {
        // 检查投票状态
        if (vote.status !== 'in_progress') {
            throw new Error('此投票已结束');
        }

        // 获取原始状态用于后续比较
        const originalVote = { ...vote };
        const oppositeChoice = choice === 'red' ? 'blue' : 'red';
        const wasInOpposite = originalVote[`${oppositeChoice}Voters`].includes(userId);
        const wasInCurrent = originalVote[`${choice}Voters`].includes(userId);

        // 执行数据库操作 - 如果已经投给同方，addVoter会直接返回原状态
        const updatedVote = await VoteModel.addVoter(vote.id, userId, choice);

        // 生成回复消息和日志
        let message, logMessage;

        if (wasInCurrent) {
            // 已经投给同方的情况
            message = `ℹ️ 你已经支持过${choice === 'red' ? '红方' : '蓝方'}诉求`;
        } else if (wasInOpposite) {
            // 从另一方换到当前方
            message = `✅ 你已将支持从${oppositeChoice === 'red' ? '红方' : '蓝方'}换到${
                choice === 'red' ? '红方' : '蓝方'
            }诉求`;
            logMessage = `[投票操作] [ID: ${vote.id}] - 用户: ${userId} 从${
                oppositeChoice === 'red' ? '红方' : '蓝方'
            }换到${choice === 'red' ? '红方' : '蓝方'}`;
        } else {
            // 新投票
            message = `✅ 你已支持${choice === 'red' ? '红方' : '蓝方'}诉求`;
            logMessage = `[投票操作] [ID: ${vote.id}] - 用户: ${userId} 支持${choice === 'red' ? '红方' : '蓝方'}`;
        }

        // 记录日志（仅在有实际变化时）
        if (logMessage) {
            logTime(logMessage);
        }

        // 匿名投票 - 只有在投票结束时才更新消息显示票数
        const shouldUpdateMessage = updatedVote.status === 'completed' && !wasInCurrent;

        return { vote: updatedVote, message, shouldUpdateMessage };
    }

    /**
     * 生成进度条
     * @private
     * @param {number} redCount - 红方票数
     * @param {number} blueCount - 蓝方票数
     * @param {boolean} showVotes - 是否显示票数
     * @returns {string} 进度条文本
     */
    static _generateProgressBar(redCount, blueCount, showVotes) {
        if (!showVotes) {
            return '🔴 ⬛⬛⬛⬛⬛⬛ ⚖️ ⬛⬛⬛⬛⬛⬛ 🔵';
        }

        const total = redCount + blueCount;
        if (total === 0) return '🔴 ⬛⬛⬛⬛⬛⬛ ⚖️ ⬛⬛⬛⬛⬛⬛ 🔵';

        const length = 12; // 12个方格
        const redLength = Math.round((redCount / total) * length);
        const blueLength = length - redLength;

        const redBar = redLength > 0 ? '🟥'.repeat(redLength) : '';
        const blueBar = blueLength > 0 ? '🟦'.repeat(blueLength) : '';

        const progressBar = `🔴 ${redBar}${redLength < length ? '⚖️' : ''}${blueBar} 🔵`;

        const redPercent = total > 0 ? ((redCount / total) * 100).toFixed(1) : '0.0';
        const bluePercent = total > 0 ? ((blueCount / total) * 100).toFixed(1) : '0.0';

        return [
            progressBar,
            `⚔️ **红方：** ${redCount} 票 (${redPercent}%)`,
            `🛡️ **蓝方：** ${blueCount} 票 (${bluePercent}%)`,
        ].join('\n');
    }

    /**
     * 获取议员总数
     * @private
     * @param {Object} client - Discord客户端
     * @returns {Promise<number>} 议员总数
     */
    static async _getSenatorsCount(client) {
        try {
            // 获取主服务器配置
            const mainGuildConfig = client.guildManager.getMainServerConfig();

            if (!mainGuildConfig?.courtSystem?.enabled || !mainGuildConfig.roleApplication?.senatorRoleId) {
                logTime('无法获取主服务器配置或议事系统未启用', true);
                return 0;
            }

            // 获取主服务器的Guild对象
            const guild = await client.guilds.fetch(mainGuildConfig.id);
            if (!guild) {
                logTime(`无法获取服务器: ${mainGuildConfig.id}`, true);
                return 0;
            }

            // 获取最新的身份组信息
            const roles = await guild.roles.fetch();
            const role = roles.get(mainGuildConfig.roleApplication?.senatorRoleId);

            if (!role) {
                logTime(`无法获取议员身份组: ${mainGuildConfig.roleApplication?.senatorRoleId}`, true);
                return 0;
            }

            // 获取所有服务器成员
            const members = await guild.members.fetch();

            // 统计拥有议员身份组的成员数量
            const senatorsCount = members.filter(
                member => member.roles.cache.has(mainGuildConfig.roleApplication?.senatorRoleId) && !member.user.bot,
            ).size;

            // 记录实际议员数量日志
            logTime(
                `议员总数(实际): ${senatorsCount}, (服务器: ${guild.name}, 身份组: ${role.name}, 身份组ID: ${role.id})`,
            );

            return senatorsCount;
        } catch (error) {
            logTime(`获取议员总数失败: ${error.message}`, true);
            return 0;
        }
    }

    /**
     * 发送投票结果通知给相关用户
     * @private
     * @param {Object} client - Discord客户端
     * @param {string} executorId - 申请人ID
     * @param {string} targetId - 目标用户ID
     * @param {Object} options - 通知选项
     * @param {Object} options.executorEmbed - 发给执行者的嵌入消息
     * @param {Object} options.targetEmbed - 发给目标用户的嵌入消息
     * @returns {Promise<void>}
     */
    static async _sendVoteResultNotification(client, executorId, targetId, { executorEmbed, targetEmbed }) {
        try {
            const [executor, target] = await Promise.all([
                client.users.fetch(executorId).catch(() => null),
                client.users.fetch(targetId).catch(() => null),
            ]);

            // 为嵌入消息添加统一的页脚和时间戳
            const commonFields = {
                timestamp: new Date(),
                footer: { text: "创作者议会通知" }
            };

            if (executor && executorEmbed) {
                await executor.send({
                    embeds: [{ ...executorEmbed, ...commonFields }]
                });
            }

            if (target && targetEmbed && executorId !== targetId) {
                await target.send({
                    embeds: [{ ...targetEmbed, ...commonFields }]
                });
            }
        } catch (error) {
            logTime(`发送投票结果通知失败: ${error.message}`, true);
        }
    }

    /**
     * 更新投票消息UI
     * @param {Object} message - Discord消息对象
     * @param {Object} vote - 投票记录
     * @param {Object} options - 更新选项
     * @returns {Promise<void>}
     */
    static async updateVoteMessage(message, vote, options = {}) {
        try {
            const { redVoters, blueVoters, redSide, blueSide, endTime, status } = vote;
            // 只有在投票结束后才显示票数
            const showVotes = status === 'completed';

            const description = [
                `${status === 'completed' ? '⏰ 投票已结束' : `⏳ 投票截止：<t:${Math.floor(endTime / 1000)}:R>`}`,
                `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━`,
                '',
                '🔴 **红方诉求：** ' + redSide,
                '',
                '🔵 **蓝方诉求：** ' + blueSide,
                '',
                `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━`,
                '',
                this._generateProgressBar(redVoters.length, blueVoters.length, showVotes),
                '',
                showVotes
                    ? `👥 **总投票人数：** ${redVoters.length + blueVoters.length}`
                    : `🔒 投票将保持匿名直至投票结束`,
            ].join('\n');

            // 构建嵌入消息
            const embed = {
                color: status === 'completed' ? (options.result === 'red_win' ? 0xff0000 : 0x0000ff) : 0x5865f2,
                title: '📊 议会辩诉投票',
                description: description,
                timestamp: new Date(),
                footer: {
                    text: status === 'completed' ? '投票已结束，请查看结果' : '点击另一色支持按钮可以换边',
                },
            };

            // 如果投票已结束，添加结果
            if (status === 'completed' && options.message) {
                embed.description += '\n\n' + ['**🏛️ 投票结果：**', options.message].join('\n');
            }

            // 更新消息
            await message.edit({
                embeds: [embed],
                components: status === 'completed' ? [] : message.components,
            });
        } catch (error) {
            logTime(`更新投票消息失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 处理投票结束后的身份组管理
     * @private
     * @param {Object} client - Discord客户端
     * @param {Object} vote - 投票记录
     * @returns {Promise<void>}
     */
    static async _handleRolesAfterVote(client, vote) {
        try {
            // 从投票详情中获取双方ID
            const { targetId, executorId } = vote.details;
            await handleDebateRolesAfterVote(client, executorId, targetId);
        } catch (error) {
            logTime(`[投票系统] 处理投票后身份组管理失败: ${error.message}`, true);
        }
    }

    /**
     * 处理上诉类型投票结果
     * @private
     * @param {Object} vote - 投票记录
     * @param {string} result - 投票结果 (red_win/blue_win)
     * @param {Object} client - Discord客户端
     * @returns {Promise<string>} 执行结果消息
     */
    static async _handleAppealVoteResult(vote, result, client) {
        const { details } = vote;
        let message = '';

        if (result === 'red_win') {
            // 红方胜利，无需额外处理，因为处罚在辩诉阶段已经被解除
            message = '，处罚已解除';

            // 发送通知
            await this._sendVoteResultNotification(
                client,
                details.executorId,
                details.targetId,
                {
                    executorEmbed: {
                        color: 0xff5555,
                        title: "⚠️ 处罚已撤销",
                        description: "您执行的处罚已被议会撤销",
                        fields: [
                            {
                                name: "撤销原因",
                                value: "上诉已通过议会投票"
                            }
                        ]
                    },
                    targetEmbed: {
                        color: 0x00ff00,
                        title: "✅ 上诉成功",
                        description: "您的上诉申请已获得议会支持",
                        fields: [
                            {
                                name: "上诉结果",
                                value: "处罚已解除"
                            }
                        ]
                    }
                }
            );
        } else {
            // 蓝方胜利，重新部署处罚
            const { punishmentId, punishmentType, originalReason, originalDuration, originalWarningDuration } = details;

            // 获取原处罚记录以获取执行者ID
            const originalPunishment = await PunishmentModel.getPunishmentById(parseInt(punishmentId));
            if (!originalPunishment) {
                throw new Error('无法获取原处罚记录');
            }

            // 获取主服务器配置
            const mainGuildConfig = client.guildManager.getMainServerConfig();

            if (!mainGuildConfig) {
                throw new Error('无法获取主服务器配置');
            }

            // 构建新的处罚数据
            const newPunishmentData = {
                userId: details.targetId,
                type: punishmentType,
                reason: `上诉驳回，恢复原处罚 - ${originalReason}`,
                duration: originalDuration,
                executorId: originalPunishment.executorId,
                warningDuration: originalWarningDuration || 0,
                processId: vote.processId,
                noAppeal: true, // 禁止再次上诉
                voteInfo: {
                    messageId: vote.messageId,
                    channelId: vote.threadId,
                    guildId: mainGuildConfig.id,
                },
            };

            // 执行新处罚
            const { success: punishSuccess, message: punishMessage } = await PunishmentService.executePunishment(
                client,
                newPunishmentData,
            );

            if (punishSuccess) {
                message = '，上诉驳回，原处罚已恢复';

                // 发送通知
                await this._sendVoteResultNotification(
                    client,
                    details.executorId,
                    details.targetId,
                    {
                        executorEmbed: {
                            color: 0x00ff00,
                            title: "✅ 处罚已维持",
                            description: "您执行的处罚维持有效",
                            fields: [
                                {
                                    name: "维持原因",
                                    value: "上诉未通过议会投票"
                                }
                            ]
                        },
                        targetEmbed: {
                            color: 0xff5555,
                            title: "❌ 上诉失败",
                            description: "您的上诉申请未获得议会支持",
                            fields: [
                                {
                                    name: "上诉结果",
                                    value: "原处罚已恢复"
                                }
                            ]
                        }
                    }
                );
            } else {
                message = `，但处罚恢复失败: ${punishMessage}`;
            }
        }

        return message;
    }

    /**
     * 处理弹劾类型投票结果
     * @private
     * @param {Object} vote - 投票记录
     * @param {string} result - 投票结果 (red_win/blue_win)
     * @param {Object} client - Discord客户端
     * @returns {Promise<string>} 执行结果消息
     */
    static async _handleImpeachmentVoteResult(vote, result, client) {
        const { details } = vote;
        let message = '';

        if (result === 'red_win') {
            try {
                // 获取主服务器配置
                const mainGuildConfig = client.guildManager.getMainServerConfig();

                // 读取身份组同步配置
                const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

                // 过滤掉需要保留的身份组
                const excludedGroupNames = ['创作者', '赛博议员', '已验证', '缓冲区'];
                const groupsToRevoke = roleSyncConfig.syncGroups.filter(
                    group => !excludedGroupNames.includes(group.name),
                );

                // 移除身份组
                const roleRevokeResult = await manageRolesByGroups(
                    client,
                    details.targetId,
                    groupsToRevoke,
                    `议会认定弹劾通过，撤销管理身份组`,
                    true // 设置为移除操作
                );

                // 获取弹劾执行者和目标用户
                const [executor, target] = await Promise.all([
                    client.users.fetch(details.executorId).catch(() => null),
                    client.users.fetch(details.targetId).catch(() => null),
                ]);

                // 发送管理日志
                const allGuilds = Array.from(client.guildManager.guilds.values());
                const notificationResults = [];

                for (const guildData of allGuilds) {
                    try {
                        if (guildData.moderationLogThreadId) {
                            const logChannel = await client.channels
                                .fetch(guildData.moderationLogThreadId)
                                .catch(() => null);
                            if (logChannel && executor && target) {
                                // 创建管理日志内容
                                const targetAvatarURL =
                                    target.displayAvatarURL({
                                        dynamic: true,
                                        size: 32,
                                        extension: 'png',
                                    }) || target.defaultAvatarURL;

                                const embed = {
                                    color: 0xff0000,
                                    title: `${target.username} 被议会弹劾`,
                                    thumbnail: {
                                        url: targetAvatarURL,
                                    },
                                    fields: [
                                        {
                                            name: '弹劾对象',
                                            value: `<@${target.id}>`,
                                            inline: true,
                                        },
                                        {
                                            name: '申请人',
                                            value: `<@${executor.id}>`,
                                            inline: true,
                                        },
                                        {
                                            name: '弹劾理由',
                                            value: details.reason || '未提供原因',
                                        },
                                    ],
                                    timestamp: new Date(),
                                    footer: { text: `流程ID: ${vote.processId}` },
                                };

                                // 添加投票信息
                                const voteLink = `https://discord.com/channels/${mainGuildConfig.id}/${vote.threadId}/${vote.messageId}`;
                                embed.fields.push({
                                    name: '议会投票',
                                    value: `[点击查看投票结果](${voteLink})`,
                                    inline: true,
                                });

                                await logChannel.send({ embeds: [embed] });
                                notificationResults.push(`服务器 ${logChannel.guild?.name || '未知服务器'} 的管理日志`);
                            }
                        }
                    } catch (error) {
                        logTime(`发送弹劾管理日志通知失败 (服务器ID: ${guildData.id}): ${error.message}`, true);
                    }
                }

                message = '，弹劾已执行';

                // 如果有身份组撤销结果，添加到消息中
                if (roleRevokeResult) {
                    logTime(
                        `弹劾结果通知: ${
                            roleRevokeResult.failedServers.length > 0 ? '部分' : '全部'
                        }服务器身份组撤销成功`,
                    );
                }

                // 发送通知给当事人
                await this._sendVoteResultNotification(
                    client,
                    details.executorId,
                    details.targetId,
                    {
                        executorEmbed: {
                            color: 0x00ff00,
                            title: "✅ 弹劾成功",
                            description: "您发起的弹劾投票已通过并执行",
                            fields: [
                                {
                                    name: "执行结果",
                                    value: "目标用户的所有管理员身份组已被撤销"
                                }
                            ]
                        },
                        targetEmbed: {
                            color: 0xff5555,
                            title: "⚠️ 弹劾通知",
                            description: "您已被议会弹劾",
                            fields: [
                                {
                                    name: "弹劾结果",
                                    value: "您的所有管理员身份组已被撤销"
                                }
                            ]
                        }
                    }
                );
            } catch (error) {
                logTime(`执行弹劾操作失败: ${error.message}`, true);
                message = `，但弹劾执行失败: ${error.message}`;
            }
        } else {
            message = '，处罚申请已驳回';

            // 发送通知
            await this._sendVoteResultNotification(
                client,
                details.executorId,
                details.targetId,
                {
                    executorEmbed: {
                        color: 0xff5555,
                        title: "❌ 弹劾失败",
                        description: "您发起的弹劾投票未通过",
                        fields: [
                            {
                                name: "驳回原因",
                                value: "未获得足够议员支持"
                            }
                        ]
                    },
                    targetEmbed: {
                        color: 0x00ff00,
                        title: "✅ 弹劾已驳回",
                        description: "针对您的弹劾申请已被议会驳回",
                        fields: [
                            {
                                name: "驳回结果",
                                value: "您的管理员身份组将被保留"
                            }
                        ]
                    }
                }
            );
        }

        return message;
    }

    /**
     * 处理处罚类型投票结果（禁言或封禁）
     * @private
     * @param {Object} vote - 投票记录
     * @param {string} result - 投票结果 (red_win/blue_win)
     * @param {Object} client - Discord客户端
     * @returns {Promise<string>} 执行结果消息
     */
    static async _handlePunishmentVoteResult(vote, result, client) {
        const { details, type } = vote;
        let message = '';

        if (result.startsWith('red_win')) {
            // 获取主服务器配置
            const mainGuildConfig = client.guildManager.getMainServerConfig();

            // 根据结果类型决定处罚内容
            let punishmentType = type === 'court_ban' ? 'ban' : 'mute';
            let duration = calculatePunishmentDuration(details.muteTime);
            let warningDuration = details.warningTime ? calculatePunishmentDuration(details.warningTime) : 0;
            let reasonPrefix = '议会认定处罚通过';

            // 对于永封投票的部分通过情况
            if (result === 'red_win_partial' && type === 'court_ban') {
                punishmentType = 'mute'; // 改为禁言
                duration = 7 * 24 * 60 * 60 * 1000; // 7天 (毫秒)
                warningDuration = 90 * 24 * 60 * 60 * 1000; // 90天 (毫秒)
                reasonPrefix = '议会认定部分处罚通过';
            }

            const punishmentDetails = {
                userId: details.targetId,
                type: punishmentType,
                reason: `${reasonPrefix}`,
                duration: duration,
                executorId: details.executorId,
                processId: vote.processId,
                warningDuration: warningDuration,
                keepMessages: details.keepMessages ?? true,
                noAppeal: true,
                voteInfo: {
                    messageId: vote.messageId,
                    channelId: vote.threadId,
                    guildId: mainGuildConfig.id,
                },
            };

            // 执行处罚
            const { success, message: punishMessage } = await PunishmentService.executePunishment(
                client,
                punishmentDetails,
            );

            if (success) {
                // 为永封投票的部分通过添加特定消息
                if (result === 'red_win_partial' && type === 'court_ban') {
                    message = '，支持率低于60%，执行7天禁言+90天警告';
                } else {
                    message = '，处罚已执行';
                }

                // 确定处罚类型文本
                const punishmentTypeText = punishmentType === 'ban' ? '永封' :
                                         punishmentType === 'mute' ? '禁言' :
                                         punishmentType === 'softban' ? '软封锁' :
                                         punishmentType === 'warning' ? '警告' : '处罚';
                const resultText = result === 'red_win_partial' ?
                    `支持率在50%-60%之间，执行7天禁言+90天警告` :
                    `处罚已执行：${punishmentTypeText}`;

                // 发送通知
                await this._sendVoteResultNotification(
                    client,
                    details.executorId,
                    details.targetId,
                    {
                        executorEmbed: {
                            color: 0x00ff00,
                            title: "✅ 处罚申请已执行",
                            description: "您发起的处罚申请已获得议会支持",
                            fields: [
                                {
                                    name: "执行结果",
                                    value: resultText
                                }
                            ]
                        },
                        targetEmbed: {
                            color: 0xff5555,
                            title: "⚠️ 处罚通知",
                            description: "议会已通过对您的处罚申请",
                            fields: [
                                {
                                    name: "处罚结果",
                                    value: resultText
                                }
                            ]
                        }
                    }
                );
            } else {
                message = `，但处罚执行失败: ${punishMessage}`;
            }
        } else {
            message = '，处罚申请已驳回';

            // 发送通知
            await this._sendVoteResultNotification(
                client,
                details.executorId,
                details.targetId,
                {
                    executorEmbed: {
                        color: 0xff5555,
                        title: "❌ 处罚申请未通过",
                        description: "您发起的处罚申请未获得议会支持",
                        fields: [
                            {
                                name: "驳回原因",
                                value: "未获得足够议员支持"
                            }
                        ]
                    },
                    targetEmbed: {
                        color: 0x00ff00,
                        title: "✅ 处罚申请已驳回",
                        description: "针对您的处罚申请已被议会驳回",
                        fields: [
                            {
                                name: "驳回结果",
                                value: "您不会受到相关处罚"
                            }
                        ]
                    }
                }
            );
        }

        return message;
    }

    /**
     * 发送投票结果嵌入消息到辩诉贴并锁定
     * @private
     * @param {Object} vote - 投票记录
     * @param {string} result - 投票结果 (red_win/blue_win)
     * @param {string} resultMessage - 结果消息
     * @param {Object} client - Discord客户端
     * @returns {Promise<void>}
     */
    static async _sendVoteResultEmbed(vote, result, resultMessage, client) {
        try {
            // 获取辩诉贴
            const thread = await client.channels.fetch(vote.threadId).catch(() => null);
            if (!thread) {
                logTime(`无法获取辩诉贴 ${vote.threadId}，无法发送结果和锁定`, true);
                return;
            }

            // 构建嵌入消息
            const resultColor = result === 'red_win' ? 0xff0000 : 0x0000ff;

            // 根据投票结果获取表情
            const resultEmoji = result === 'red_win' ? '🔴' : '🔵';

            // 获取投票数
            const redCount = vote.redVoters.length;
            const blueCount = vote.blueVoters.length;

            const resultEmbed = {
                color: resultColor,
                title: `📜 议会辩诉决议 ${vote.id} 号`,
                description: [
                    `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━`,
                    ``,
                    `⚔️ **红方票数：** ${redCount} 票`,
                    `🛡️ **蓝方票数：** ${blueCount} 票`,
                    `👥 **支持率：** ${((redCount / (redCount + blueCount)) * 100).toFixed(2)}% / ${(
                        (blueCount / (redCount + blueCount)) *
                        100
                    ).toFixed(2)}%`,
                    ``,
                    `${resultEmoji} **最终裁决：** ${resultMessage}`,
                    ``,
                    `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━`,
                ].join('\n'),
                footer: {
                    text: '此结果由议会表决产生，具有最终效力',
                },
                timestamp: new Date(),
            };

            // 发送结果消息
            await thread.send({ embeds: [resultEmbed] });

            // 锁定辩诉贴
            await thread.setLocked(true, '议会辩诉已结束');
        } catch (error) {
            logTime(`发送投票结果到辩诉贴并锁定失败: ${error.message}`, true);
            // 不抛出错误，避免影响主流程
        }
    }

    /**
     * 检查并执行投票结果
     * @param {Object} vote - 投票记录
     * @param {Object} client - Discord客户端
     * @returns {Promise<{result: string, message: string}>} 执行结果和提示消息
     */
    static async executeVoteResult(vote, client) {
        try {
            // 获取最新的投票数据
            const latestVote = await VoteModel.getVoteById(vote.id);
            if (!latestVote) {
                throw new Error('无法获取投票数据');
            }

            // 获取当前实时的议员总数
            const currentTotalVoters = await this._getSenatorsCount(client);
            if (currentTotalVoters === 0) {
                throw new Error('无法获取当前议员总数');
            }

            const { redVoters, blueVoters, type } = latestVote;
            const redCount = redVoters.length;
            const blueCount = blueVoters.length;
            const threshold = Math.ceil(20 + currentTotalVoters * 0.01); // 使用"20+1%议员人数"作为有效阈值
            const total = redCount + blueCount;
            const redSupportRate = total > 0 ? redCount / total : 0;

            // 处理投票后的身份组管理
            await this._handleRolesAfterVote(client, latestVote);

            // 判断结果
            let result, message;

            if (redCount + blueCount < threshold) {
                result = 'blue_win';
                message = `投票人数未达到${threshold}票，执行蓝方诉求`;
            } else if (redCount === blueCount) {
                result = 'blue_win';
                message = '投票持平，执行蓝方诉求';
            } else {
                // 永封投票使用阶段判定逻辑
                if (type === 'court_ban') {
                    if (redSupportRate >= 0.6) {
                        result = 'red_win';
                        message = '红方获胜，支持率达到60%以上，执行永封';
                    } else if (redSupportRate > 0.5) {
                        result = 'red_win_partial';
                        message = '红方获胜，支持率在50%-60%之间，执行7天禁言+90天警告';
                    } else {
                        result = 'blue_win';
                        message = '红方支持率不足50%，执行蓝方诉求';
                    }
                } else {
                    // 其他类型投票保持原有逻辑
                    result = redCount > blueCount ? 'red_win' : 'blue_win';
                    message = `${result === 'red_win' ? '红方' : '蓝方'}获胜`;
                }
            }

            // 处理器映射表
            const resultHandlers = {
                appeal: this._handleAppealVoteResult,
                court_impeach: this._handleImpeachmentVoteResult,
                court_ban: this._handlePunishmentVoteResult,
                court_mute: this._handlePunishmentVoteResult,
            };

            // 根据投票类型选择对应的处理器
            const handler = resultHandlers[type];
            let resultMessage = await handler.call(this, latestVote, result, client);

            // 构建完整结果消息
            message += resultMessage;

            // 记录日志
            logTime(
                `投票结束 [ID: ${latestVote.id}] - ` +
                    `结果: ${result}, ` +
                    `当前总议员: ${currentTotalVoters}, 有效阈值: ${threshold}票` +
                    `红方: ${redCount}票, ` +
                    `蓝方: ${blueCount}票` +
                    (type === 'court_ban' ? `, 红方支持率: ${(redSupportRate * 100).toFixed(2)}%` : ''),
            );

            // 完成后更新状态
            await VoteModel.updateStatus(latestVote.id, 'completed', { result });

            // 发送投票结果嵌入消息到辩诉贴
            await this._sendVoteResultEmbed(latestVote, result, message, client);

            return { result, message };
        } catch (error) {
            // 如果执行失败，恢复状态
            await VoteModel.updateStatus(vote.id, 'in_progress');
            logTime(`执行投票结果失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 处理投票按钮交互
     * @param {ButtonInteraction} interaction - Discord按钮交互对象
     * @param {string} choice - 投票选择 ('red' | 'blue')
     * @returns {Promise<void>}
     */
    static async handleVoteButton(interaction, choice) {
        try {

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
            } = await this.handleVote(vote, interaction.user.id, choice);

            // 只有在应该更新消息时才更新
            if (shouldUpdateMessage) {
                await this.updateVoteMessage(interaction.message, updatedVote);
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
                    const { result, message: resultMessage } = await this.executeVoteResult(
                        currentVote,
                        interaction.client,
                    );

                    // 获取最新的投票状态
                    const finalVote = await VoteModel.getVoteById(updatedVote.id);

                    // 更新消息显示结果
                    await this.updateVoteMessage(interaction.message, finalVote, {
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
            // 处理错误
            logTime(`处理投票按钮出错: ${error.message}`, true);
            await interaction.editReply({
                content: '❌ 处理投票请求时出错，请稍后重试',
            });
        }
    }
}

export { VoteService };
