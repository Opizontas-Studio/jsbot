import { readFileSync } from 'fs';
import { join } from 'path';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import { checkCooldown } from '../handlers/buttons.js';
import { logTime } from '../utils/logger.js';
import { calculatePunishmentDuration } from '../utils/punishmentHelper.js';
import PunishmentService from './punishmentService.js';
import { addRolesByGroups, revokeRolesByGroups } from './roleApplication.js';

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

            if (!guildConfig.courtSystem.votePublicDelay || !guildConfig.courtSystem.voteDuration) {
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
            const publicDelay = guildConfig.courtSystem.votePublicDelay;
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
                publicTime: now + publicDelay,
            });

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

        // 执行投票
        const updatedVote = await VoteModel.addVoter(vote.id, userId, choice);

        // 记录投票操作
        const hasVoted = updatedVote[`${choice}Voters`].includes(userId);
        logTime(
            `[投票操作] [ID: ${vote.id}] - 用户: ${userId} ${hasVoted ? '支持' : '取消支持'}${
                choice === 'red' ? '红方' : '蓝方'
            }`,
        );

        // 生成回复消息
        const message = this._generateVoteMessage(updatedVote, userId, choice);

        // 只有在到达公开时间后才更新消息显示票数
        const now = Date.now();
        if (now >= updatedVote.publicTime) {
            // 如果已到公开时间，返回更新消息的标记
            return { vote: updatedVote, message, shouldUpdateMessage: true };
        }

        return { vote: updatedVote, message, shouldUpdateMessage: false };
    }

    /**
     * 移除双方的辩诉通行身份组
     * @private
     * @param {Object} client - Discord客户端
     * @param {Object} vote - 投票记录
     * @returns {Promise<void>}
     */
    static async _removeDebateRolesFromBothParties(client, vote) {
        try {
            // 获取主服务器配置
            const mainGuildConfig = Array.from(client.guildManager.guilds.values()).find(
                config => config.serverType === 'Main server',
            );

            if (!mainGuildConfig?.courtSystem?.enabled || !mainGuildConfig.roleApplication?.appealDebateRoleId) {
                return;
            }

            const mainGuild = await client.guilds.fetch(mainGuildConfig.id).catch(() => null);
            if (!mainGuild) {
                return;
            }

            // 从投票详情中获取双方ID
            const { targetId, executorId } = vote.details;

            // 获取双方成员对象
            const [executorMember, targetMember] = await Promise.all([
                mainGuild.members.fetch(executorId).catch(() => null),
                mainGuild.members.fetch(targetId).catch(() => null),
            ]);

            // 为双方移除辩诉通行身份组
            const removeRolePromises = [executorMember, targetMember]
                .filter(member => member) // 过滤掉不存在的成员
                .map(member =>
                    member.roles
                        .remove(mainGuildConfig.roleApplication?.appealDebateRoleId, '投票结束，移除辩诉通行身份组')
                        .then(() => logTime(`[投票系统] 已移除用户 ${member.user.tag} 的辩诉通行身份组`))
                        .catch(error =>
                            logTime(`[投票系统] 移除辩诉通行身份组失败 (${member.user.tag}): ${error.message}`, true),
                        ),
                );

            await Promise.all(removeRolePromises);
        } catch (error) {
            logTime(`[投票系统] 移除辩诉通行身份组失败: ${error.message}`, true);
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
            // 获取最新的投票数据，避免使用可能过期的数据
            const latestVote = await VoteModel.getVoteById(vote.id);
            if (!latestVote) {
                throw new Error('无法获取投票数据');
            }

            // 获取当前实时的议员总数
            const currentTotalVoters = await this._getSenatorsCount(client);
            if (currentTotalVoters === 0) {
                throw new Error('无法获取当前议员总数');
            }

            const { redVoters, blueVoters, details, type } = latestVote;
            const redCount = redVoters.length;
            const blueCount = blueVoters.length;
            const threshold = 1;
            // Math.ceil(20 + currentTotalVoters * 0.01); // 使用"20+1%议员人数"作为有效阈值

            // 在执行结果之前，先移除双方的辩诉通行身份组
            await this._removeDebateRolesFromBothParties(client, latestVote);

            // 恢复已验证身份组
            try {
                // 读取身份组同步配置
                const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

                // 找到已验证身份组的同步组
                const verifiedGroup = roleSyncConfig.syncGroups.find(group => group.name === '已验证');
                if (verifiedGroup) {
                    // 为目标用户恢复已验证身份组
                    await addRolesByGroups(client, details.targetId, [verifiedGroup], '投票结束，恢复已验证身份组');
                    logTime(`[投票系统] 已为用户 ${details.targetId} 恢复已验证身份组`);
                }
            } catch (error) {
                logTime(`[投票系统] 恢复已验证身份组失败: ${error.message}`, true);
            }

            // 判断结果
            let result, message;
            if (redCount + blueCount < threshold) {
                result = 'blue_win';
                message = `投票人数未达到${threshold}票，执行蓝方诉求`;
            } else if (redCount === blueCount) {
                result = 'blue_win';
                message = '投票持平，执行蓝方诉求';
            } else {
                result = redCount > blueCount ? 'red_win' : 'blue_win';
                message = `${result === 'red_win' ? '红方' : '蓝方'}获胜`;
            }

            // 执行结果
            if (type === 'appeal') {
                if (result === 'red_win') {
                    // 红方胜利，无需额外处理，因为处罚在辩诉阶段已经被解除
                    message += '，处罚已解除';
                } else {
                    // 蓝方胜利，重新部署处罚
                    const { punishmentId, punishmentType, originalReason, originalDuration, originalWarningDuration } =
                        details;

                    // 获取原处罚记录以获取执行者ID
                    const originalPunishment = await PunishmentModel.getPunishmentById(parseInt(punishmentId));
                    if (!originalPunishment) {
                        throw new Error('无法获取原处罚记录');
                    }

                    // 获取主服务器配置
                    const mainGuildConfig = client.guildManager.getGuildConfig(
                        client.guildManager
                            .getGuildIds()
                            .find(id => client.guildManager.getGuildConfig(id)?.serverType === 'Main server'),
                    );

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
                        processId: latestVote.processId,
                        noAppeal: true, // 禁止再次上诉
                        voteInfo: {
                            messageId: vote.messageId,
                            channelId: vote.threadId,
                            guildId: mainGuildConfig.id,
                        },
                    };

                    // 执行新处罚
                    const { success: punishSuccess, message: punishMessage } =
                        await PunishmentService.executePunishment(client, newPunishmentData);

                    if (punishSuccess) {
                        message += '，上诉驳回，原处罚已恢复';

                        // 发送通知
                        try {
                            const [executor, target] = await Promise.all([
                                client.users.fetch(details.executorId),
                                client.users.fetch(details.targetId),
                            ]);

                            const notifyContent = '❌ 有关您的上诉未通过，原处罚已恢复。';
                            if (executor) await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                            if (target) await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                        } catch (error) {
                            logTime(`发送上诉结果通知失败: ${error.message}`, true);
                        }
                    } else {
                        message += `，但处罚恢复失败: ${punishMessage}`;
                    }
                }
            } else if (type.startsWith('court_')) {
                if (result === 'red_win') {
                    // 获取主服务器配置
                    const mainGuildConfig = client.guildManager.getGuildConfig(
                        client.guildManager
                            .getGuildIds()
                            .find(id => client.guildManager.getGuildConfig(id)?.serverType === 'Main server'),
                    );

                    if (!mainGuildConfig) {
                        throw new Error('无法获取主服务器配置');
                    }

                    // 弹劾类型的特殊处理
                    if (type === 'court_impeach') {
                        try {
                            // 读取身份组同步配置
                            const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

                            // 过滤掉需要保留的身份组
                            const excludedGroupNames = ['创作者', '赛博议员', '已验证', '缓冲区'];
                            const groupsToRevoke = roleSyncConfig.syncGroups.filter(
                                group => !excludedGroupNames.includes(group.name),
                            );

                            // 移除身份组
                            const roleRevokeResult = await revokeRolesByGroups(
                                client,
                                details.targetId,
                                groupsToRevoke,
                                `议会认定弹劾通过，撤销管理身份组`,
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
                                                    size: 64,
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
                                                footer: { text: `流程ID: ${latestVote.processId}` },
                                            };

                                            // 添加投票信息
                                            const voteLink = `https://discord.com/channels/${mainGuildConfig.id}/${vote.threadId}/${vote.messageId}`;
                                            embed.fields.push({
                                                name: '议会投票',
                                                value: `[点击查看投票结果](${voteLink})`,
                                                inline: true,
                                            });

                                            await logChannel.send({ embeds: [embed] });
                                            notificationResults.push(
                                                `服务器 ${logChannel.guild?.name || '未知服务器'} 的管理日志`,
                                            );
                                        }
                                    }
                                } catch (error) {
                                    logTime(
                                        `发送弹劾管理日志通知失败 (服务器ID: ${guildData.id}): ${error.message}`,
                                        true,
                                    );
                                }
                            }

                            message += '，弹劾已执行';

                            // 如果有身份组撤销结果，添加到消息中
                            if (roleRevokeResult) {
                                logTime(
                                    `弹劾结果通知: ${
                                        roleRevokeResult.failedServers.length > 0 ? '部分' : '全部'
                                    }服务器身份组撤销成功`,
                                );
                            }

                            // 发送通知给当事人
                            try {
                                if (executor) {
                                    await executor.send({
                                        content:
                                            '✅ 有关您的弹劾申请投票已通过并执行。目标用户的所有管理员身份组已被撤销',
                                    });
                                }

                                if (target) {
                                    await target.send({
                                        content: '⚠️ 您已被议会弹劾，您的所有管理员身份组已被撤销',
                                    });
                                }
                            } catch (error) {
                                logTime(`发送弹劾结果通知失败: ${error.message}`, true);
                            }
                        } catch (error) {
                            logTime(`执行弹劾操作失败: ${error.message}`, true);
                            message += `，但弹劾执行失败: ${error.message}`;
                        }
                    } else {
                        const punishmentDetails = {
                            userId: details.targetId,
                            type: type === 'court_ban' ? 'ban' : 'mute',
                            reason: `议会认定处罚通过`,
                            duration: calculatePunishmentDuration(details.muteTime),
                            executorId: details.executorId,
                            processId: latestVote.processId,
                            warningDuration: details.warningTime ? calculatePunishmentDuration(details.warningTime) : 0,
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
                            message += '，处罚已执行';

                            // 发送通知
                            try {
                                const [executor, target] = await Promise.all([
                                    client.users.fetch(details.executorId),
                                    client.users.fetch(details.targetId),
                                ]);

                                const notifyContent = '✅ 有关您的议事处罚投票已通过并执行。';
                                if (executor) await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                                if (target) await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                            } catch (error) {
                                logTime(`发送投票结果通知失败: ${error.message}`, true);
                            }
                        } else {
                            message += `，但处罚执行失败: ${punishMessage}`;
                        }
                    }
                } else {
                    message += '，处罚申请已驳回';

                    // 发送简单通知
                    try {
                        const [executor, target] = await Promise.all([
                            client.users.fetch(details.executorId),
                            client.users.fetch(details.targetId),
                        ]);

                        // 根据类型发送不同的通知内容
                        let notifyContent;
                        if (type === 'court_impeach') {
                            notifyContent = '❌ 有关您的弹劾申请投票未通过，申请已驳回。';
                        } else {
                            notifyContent = '❌ 有关您的议事处罚投票未通过，申请已驳回。';
                        }

                        if (executor) await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                        if (target) await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                    } catch (error) {
                        logTime(`发送投票结果通知失败: ${error.message}`, true);
                    }
                }
            }

            // 使用当前议员总数
            logTime(
                `投票结束 [ID: ${latestVote.id}] - ` +
                    `结果: ${result}, ` +
                    `当前总议员: ${currentTotalVoters}, 有效阈值: ${threshold}票` +
                    `红方: ${redCount}票, ` +
                    `蓝方: ${blueCount}票`,
            );
            logTime(`投票详情 [ID: ${latestVote.id}] - ${message}`);

            // 完成后更新状态
            await VoteModel.updateStatus(latestVote.id, 'completed', { result });

            // 发送投票结果嵌入消息到辩诉贴
            try {
                // 获取辩诉贴
                const thread = await client.channels.fetch(latestVote.threadId).catch(() => null);
                if (thread) {
                    // 构建嵌入消息
                    const resultColor = result === 'red_win' ? 0xff0000 : 0x0000ff;

                    // 根据投票结果获取表情
                    const resultEmoji = result === 'red_win' ? '🔴' : '🔵';

                    const resultEmbed = {
                        color: resultColor,
                        title: `📜 议会辩诉决议 ${latestVote.id} 号`,
                        description: [
                            `━━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━━`,
                            ``,
                            `⚔️ **红方票数：** ${redCount} 票`,
                            `🛡️ **蓝方票数：** ${blueCount} 票`,
                            `👥 **支持率：** ${((redCount / (redCount + blueCount)) * 100).toFixed(2)}% / ${(
                                (blueCount / (redCount + blueCount)) *
                                100
                            ).toFixed(2)}%`,
                            ``,
                            `${resultEmoji} **最终裁决：** ${message}`,
                            ``,
                            `━━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━━`,
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

                    logTime(`辩诉贴 ${latestVote.threadId} 已锁定，投票结果已发送`);
                } else {
                    logTime(`无法获取辩诉贴 ${latestVote.threadId}，无法发送结果和锁定`, true);
                }
            } catch (error) {
                logTime(`发送投票结果到辩诉贴并锁定失败: ${error.message}`, true);
                // 不抛出错误，避免影响主流程
            }

            return { result, message };
        } catch (error) {
            // 如果执行失败，恢复状态
            await VoteModel.updateStatus(vote.id, 'in_progress');
            logTime(`执行投票结果失败: ${error.message}`, true);
            throw error;
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
            const { redVoters, blueVoters, redSide, blueSide, publicTime, endTime, status } = vote;
            const now = Date.now();
            const canShowCount = now >= publicTime;

            const description = [
                `${status === 'completed' ? '⏰ 投票已结束' : `⏳ 投票截止：<t:${Math.floor(endTime / 1000)}:R>`}`,
                `━━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━━`,
                '',
                '🔴 **红方诉求：** ' + redSide,
                '',
                '🔵 **蓝方诉求：** ' + blueSide,
                '',
                `━━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━━`,
                '',
                this._generateProgressBar(redVoters.length, blueVoters.length, canShowCount),
                '',
                canShowCount
                    ? `👥 **总投票人数：** ${redVoters.length + blueVoters.length}`
                    : `🔒 票数将在 <t:${Math.floor(publicTime / 1000)}:R> 公开`,
            ].join('\n');

            // 构建嵌入消息
            const embed = {
                color: status === 'completed' ? (options.result === 'red_win' ? 0xff0000 : 0x0000ff) : 0x5865f2,
                title: '📊 议会辩诉投票',
                description: description,
                timestamp: new Date(),
                footer: {
                    text:
                        status === 'completed'
                            ? '投票已结束，请查看结果'
                            : '再次点击同色支持可以撤销，点击另一色支持按钮换边',
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

            // 只在定时器触发时记录日志，避免重复记录
            if (canShowCount && !options.result && options.isSchedulerUpdate) {
                logTime(`投票公开 [ID: ${vote.id}] - 当前票数 红方: ${redVoters.length}, 蓝方: ${blueVoters.length}`);
            }
        } catch (error) {
            logTime(`更新投票消息失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 生成进度条
     * @private
     * @param {number} redCount - 红方票数
     * @param {number} blueCount - 蓝方票数
     * @param {boolean} canShowCount - 是否显示总票数
     * @returns {string} 进度条文本
     */
    static _generateProgressBar(redCount, blueCount, canShowCount) {
        const total = redCount + blueCount;
        if (total === 0) return '🔴 ⬛⬛⬛⬛⬛⬛⬛ ⚖️ ⬛⬛⬛⬛⬛⬛⬛ 🔵';

        const length = 14; // 14个方格
        const redLength = Math.round((redCount / total) * length);
        const blueLength = length - redLength;

        const redBar = redLength > 0 ? '🟥'.repeat(redLength) : '';
        const blueBar = blueLength > 0 ? '🟦'.repeat(blueLength) : '';

        const progressBar = `🔴 ${redBar}${redLength < length ? '⚖️' : ''}${blueBar} 🔵`;

        if (!canShowCount) return progressBar;

        const redPercent = total > 0 ? ((redCount / total) * 100).toFixed(1) : '0.0';
        const bluePercent = total > 0 ? ((blueCount / total) * 100).toFixed(1) : '0.0';

        return [
            progressBar,
            `⚔️ **红方：** ${redCount} 票 (${redPercent}%)`,
            `🛡️ **蓝方：** ${blueCount} 票 (${bluePercent}%)`,
        ].join('\n');
    }

    /**
     * 生成投票提示消息
     * @private
     * @param {Object} vote - 投票记录
     * @param {string} userId - 投票用户ID
     * @param {string} choice - 投票选择
     * @returns {string} 提示消息
     */
    static _generateVoteMessage(vote, userId, choice) {
        const hasVoted = vote[`${choice}Voters`].includes(userId);
        return hasVoted
            ? `✅ 你已支持${choice === 'red' ? '红方' : '蓝方'}诉求`
            : `✅ 你已取消对${choice === 'red' ? '红方' : '蓝方'}诉求的支持`;
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
            const mainGuildConfig = Array.from(client.guildManager.guilds.values()).find(
                config => config.serverType === 'Main server',
            );

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
                `议员总数(实际): ${senatorsCount} ` +
                    `(服务器: ${guild.name}, ` +
                    `身份组: ${role.name}, ` +
                    `身份组ID: ${role.id})`,
            );

            return senatorsCount;
        } catch (error) {
            logTime(`获取议员总数失败: ${error.message}`, true);
            return 0;
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
            // 检查冷却时间
            const cooldownLeft = checkCooldown('vote', interaction.user.id, 60000); // 1分钟冷却
            if (cooldownLeft) {
                return await interaction.editReply({
                    content: `❌ 请等待 ${cooldownLeft} 秒后再次投票`,
                });
            }

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
