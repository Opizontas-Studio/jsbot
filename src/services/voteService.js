import { readFileSync } from 'fs';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import { logTime } from '../utils/logger.js';
import { calculatePunishmentDuration } from '../utils/punishmentHelper.js';
import PunishmentService from './punishmentService.js';
import { revokeRolesByGroups } from './roleApplication.js';

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
            const totalVoters = guildConfig.roleApplication?.senatorRoleId
                ? await this._getSenatorsCount(client)
                : 0;

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
                const punishType = type === 'court_ban' ? '永封' : '禁言';
                redSide = `对 <@${targetId}> 执行${punishType}`;
                blueSide = '驳回处罚申请';

                // 构建投票详情
                voteDetails = {
                    ...details,
                    targetId,
                    executorId,
                    punishmentType: type === 'court_ban' ? 'ban' : 'mute',
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
            `投票操作 [ID: ${vote.id}] - 用户: ${userId} ${hasVoted ? '支持' : '取消支持'}${
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
            const mainGuildConfig = Array.from(client.guildManager.guilds.values())
                .find(config => config.serverType === 'Main server');

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
                        .then(() => logTime(`已移除用户 ${member.user.tag} 的辩诉通行身份组`))
                        .catch(error => logTime(`移除辩诉通行身份组失败 (${member.user.tag}): ${error.message}`, true)),
                );

            await Promise.all(removeRolePromises);
        } catch (error) {
            logTime(`移除辩诉通行身份组失败: ${error.message}`, true);
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
            const threshold = Math.ceil(20 + currentTotalVoters * 0.01); // 使用"20+1%议员人数"作为有效阈值

            // 在执行结果之前，先移除双方的辩诉通行身份组
            await this._removeDebateRolesFromBothParties(client, latestVote);

            // 判断结果
            let result, message;
            if (redCount + blueCount < threshold) {
                result = 'blue_win';
                message = `投票人数未达到有效标准（${threshold}票），执行蓝方诉求`;
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
                        client.guildManager.getGuildIds()
                            .find(id => client.guildManager.getGuildConfig(id)?.serverType === 'Main server')
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
                            guildId: mainGuildConfig.id
                        }
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
                        client.guildManager.getGuildIds()
                            .find(id => client.guildManager.getGuildConfig(id)?.serverType === 'Main server')
                    );

                    if (!mainGuildConfig) {
                        throw new Error('无法获取主服务器配置');
                    }

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
                            guildId: mainGuildConfig.id
                        }
                    };

                    // 如果是禁言且需要撤销身份组
                    let roleRevokeResult = null;
                    if (type === 'court_mute' && details.revokeRoleId) {
                        // 构造临时同步组
                        const tempSyncGroup = {
                            name: '处罚撤销',
                            roles: {}
                        };

                        // 读取身份组同步配置，查找对应的同步组
                        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                        let foundSyncGroup = roleSyncConfig.syncGroups.find(group =>
                            Object.values(group.roles).includes(details.revokeRoleId)
                        );

                        // 如果找到同步组，使用其配置；否则只在当前服务器移除
                        tempSyncGroup.roles = foundSyncGroup ? foundSyncGroup.roles : {
                            [client.guildManager.getMainGuildId()]: details.revokeRoleId
                        };

                        roleRevokeResult = await revokeRolesByGroups(
                            client,
                            details.targetId,
                            [tempSyncGroup],
                            `议会认定处罚通过，撤销身份组`
                        );
                    }

                    // 执行处罚
                    const { success, message: punishMessage } = await PunishmentService.executePunishment(
                        client,
                        punishmentDetails,
                    );

                    if (success) {
                        message += '，处罚已执行';
                        // 如果有身份组撤销结果，添加到消息中
                        if (roleRevokeResult) {
                            if (roleRevokeResult.failedServers.length > 0) {
                                message += `\n⚠️ 部分服务器身份组撤销失败: ${roleRevokeResult.failedServers
                                    .map(s => s.name)
                                    .join(', ')}`;
                            }
                        }

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
                } else {
                    message += '，处罚申请已驳回';

                    // 发送简单通知
                    try {
                        const [executor, target] = await Promise.all([
                            client.users.fetch(details.executorId),
                            client.users.fetch(details.targetId),
                        ]);

                        const notifyContent = '❌ 有关您的议事处罚投票未通过，申请已驳回。';
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
                status === 'completed' ? '投票已结束' : `投票截止：<t:${Math.floor(endTime / 1000)}:R>`,
                '',
                '🔴 **红方诉求：**',
                redSide,
                '',
                '🔵 **蓝方诉求：**',
                blueSide,
                '',
                this._generateProgressBar(redVoters.length, blueVoters.length, canShowCount),
                '',
                canShowCount
                    ? `总投票人数：${redVoters.length + blueVoters.length}`
                    : `票数将在 <t:${Math.floor(publicTime / 1000)}:R> 公开`,
            ].join('\n');

            // 构建嵌入消息
            const embed = {
                color: 0x5865f2,
                title: status === 'completed' ? '📊 投票已结束' : '📊 辩诉投票',
                description: description,
                timestamp: new Date(),
            };

            // 如果投票已结束，添加结果
            if (status === 'completed' && options.message) {
                embed.description += '\n\n' + ['**投票结果：**', options.message].join('\n');

                // 根据结果调整颜色
                if (options.result === 'red_win') {
                    embed.color = 0xff0000; // 红色
                } else if (options.result === 'blue_win') {
                    embed.color = 0x0000ff; // 蓝色
                }
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
        if (total === 0) return '🔴▬▬▬▬▬|▬▬▬▬▬🔵';

        const length = 10;
        const redLength = Math.round((redCount / total) * length);
        const blueLength = length - redLength;

        // 修改进度条生成逻辑，使其更直观
        // 当红方票数多时，▬ 在左边（红方）多一些
        // 当蓝方票数多时，▬ 在右边（蓝方）多一些
        const leftPart = '▬'.repeat(redLength);
        const rightPart = '▬'.repeat(blueLength);

        return [
            // 调整顺序，确保进度条方向正确
            redCount >= blueCount
                ? `🔴${leftPart}|${rightPart}🔵` // 红方领先或相等
                : `🔴${leftPart}|${rightPart}🔵`, // 蓝方领先
            canShowCount ? `\n红方: ${redCount} | 蓝方: ${blueCount}` : '',
        ].join('');
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
            const mainGuildConfig = Array.from(client.guildManager.guilds.values())
                .find(config => config.serverType === 'Main server');

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
                member => member.roles.cache.has(mainGuildConfig.roleApplication?.senatorRoleId) && !member.user.bot
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
}

export { VoteService };
