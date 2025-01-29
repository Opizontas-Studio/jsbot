import { VoteModel } from '../db/models/voteModel.js';
import { logTime } from '../utils/logger.js';
import { revokePunishmentInGuilds } from '../utils/punishmentHelper.js';
import PunishmentService from './punishmentService.js';

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
            const totalVoters = guildConfig.courtSystem.senatorRoleId
                ? await this._getSenatorsCount(guildConfig, client)
                : 0;

            if (totalVoters === 0) {
                throw new Error('无法获取议员总数或议员总数为0');
            }

            let redSide, blueSide;
            if (type === 'appeal') {
                redSide = `解除对 <@${targetId}> 的处罚`;
                blueSide = '维持原判';
            } else if (type.startsWith('court_')) {
                const punishType = type === 'court_ban' ? '永封' : '禁言';
                redSide = `对 <@${targetId}> 执行${punishType}`;
                blueSide = '驳回处罚申请';
            } else {
                throw new Error('不支持的议事类型');
            }

            // 确保details中包含所有必要的信息
            const voteDetails = {
                ...details,
                targetId,
                executorId,
                punishmentType: type === 'court_ban' ? 'ban' : 'mute',
                // 确保这些字段存在
                reason: details.reason || '无原因',
                duration: details.duration || 0,
                warningDuration: details.warningDuration || 0,
                keepMessages: details.keepMessages || false,
            };

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

        // 检查30秒刷新周期
        const lastVoteTime = vote[choice === 'red' ? 'redVoters' : 'blueVoters'].includes(userId) ? vote.updatedAt : 0;

        if (lastVoteTime && Date.now() - lastVoteTime < 30 * 1000) {
            throw new Error('请等待30秒后再次投票');
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

            const { redVoters, blueVoters, totalVoters, details, type } = latestVote;
            const redCount = redVoters.length;
            const blueCount = blueVoters.length;
            const threshold = Math.ceil(totalVoters * 0.1); // 10%阈值

            // 判断结果
            let result, message;
            if (redCount + blueCount < threshold) {
                result = 'blue_win';
                message = `投票人数未达到议员总数10%（${threshold}票），执行蓝方诉求`;
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
                    // 获取目标用户
                    const target = await client.users.fetch(details.targetId);
                    if (!target) {
                        throw new Error('无法获取目标用户信息');
                    }

                    // 解除处罚
                    const { success, successfulServers, failedServers } = await revokePunishmentInGuilds(
                        client,
                        { id: details.punishmentId, type: details.punishmentType },
                        target,
                        '投票通过，处罚已解除',
                        { isAppeal: true },
                    );

                    if (success) {
                        message += '，处罚已解除';
                        if (failedServers.length > 0) {
                            message += `\n⚠️ 部分服务器解除失败: ${failedServers.map(s => s.name).join(', ')}`;
                        }
                    } else {
                        message += '，但处罚解除失败';
                    }
                } else {
                    message += '，维持原判';
                }
            } else if (type.startsWith('court_')) {
                if (result === 'red_win') {
                    // 执行处罚
                    const { success, message: punishMessage } = await PunishmentService.executePunishment(client, {
                        userId: details.targetId,
                        type: type === 'court_ban' ? 'ban' : 'mute',
                        reason: details.reason,
                        duration: details.duration,
                        executorId: details.executorId,
                        processId: latestVote.processId,
                        warningDuration: details.warningDuration,
                        keepMessages: details.keepMessages,
                    });

                    if (success) {
                        message += '，处罚已执行';
                    } else {
                        message += `，但处罚执行失败: ${punishMessage}`;
                    }
                } else {
                    message += '，处罚申请已驳回';
                }
            }

            // 修改最终日志格式
            logTime(
                `投票结束 [ID: ${latestVote.id}] - ` +
                    `结果: ${result}, ` +
                    `总议员: ${totalVoters}, ` +
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

            const publicDelaySeconds = Math.ceil((vote.publicTime - vote.startTime) / 1000);
            const description = [
                status === 'completed' ? '议事已结束' : `议事截止：<t:${Math.floor(endTime / 1000)}:R>`,
                '',
                '**红方诉求：**',
                redSide,
                '',
                '**蓝方诉求：**',
                blueSide,
                '',
                this._generateProgressBar(redVoters.length, blueVoters.length, canShowCount),
                '',
                canShowCount
                    ? `总投票人数：${redVoters.length + blueVoters.length}`
                    : `票数将在${publicDelaySeconds}秒后公开`,
            ].join('\n');

            // 构建嵌入消息
            const embed = {
                color: 0x5865f2,
                title: status === 'completed' ? '📊 投票已结束' : '📊 议事投票',
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
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} client - Discord客户端
     * @returns {Promise<number>} 议员总数
     */
    static async _getSenatorsCount(guildConfig, client) {
        if (!guildConfig?.courtSystem?.enabled || !guildConfig.courtSystem.senatorRoleId) {
            return 0;
        }

        try {
            // 获取主服务器的Guild对象
            const guild = await client.guilds.fetch(guildConfig.id);
            if (!guild) {
                logTime(`无法获取服务器: ${guildConfig.id}`, true);
                return 0;
            }

            // 获取最新的身份组信息
            const roles = await guild.roles.fetch();
            const role = roles.get(guildConfig.courtSystem.senatorRoleId);

            if (!role) {
                logTime(`无法获取议员身份组: ${guildConfig.courtSystem.senatorRoleId}`, true);
                return 0;
            }

            // 使用 GuildMemberManager 的 list 方法获取成员
            const members = await guild.members.list({ limit: 1000 }); // 设置合适的限制
            const senatorCount = members.filter(member =>
                member.roles.cache.has(guildConfig.courtSystem.senatorRoleId),
            ).size;

            // 记录议员数量日志
            logTime(
                `获取议员总数: ${senatorCount} ` +
                    `(服务器: ${guild.name}, ` +
                    `身份组: ${role.name}, ` +
                    `身份组ID: ${role.id}, ` +
                    `总成员: ${members.size})`,
            );

            if (senatorCount === 0) {
                logTime(`警告：未找到任何议员成员，这可能是权限问题`, true);
            }

            return senatorCount;
        } catch (error) {
            logTime(`获取议员总数失败: ${error.message}`, true);
            return 0;
        }
    }
}

export { VoteService };
