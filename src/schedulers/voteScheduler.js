import schedule from 'node-schedule';
import { dbManager } from '../sqlite/dbManager.js';
import { VoteModel } from '../sqlite/models/voteModel.js';
import { VoteService } from '../services/voteService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 投票调度器
 */
export class VoteScheduler {
    constructor() {
        this.jobs = new Map(); // 存储所有投票的定时任务
        this.votes = new Map(); // 存储所有活跃投票的状态
    }

    /**
     * 初始化投票调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        const result = await ErrorHandler.handleService(
            async () => {
                const votes = await dbManager.safeExecute(
                    'all',
                    `SELECT * FROM votes
                    WHERE status = 'in_progress'
                    AND endTime > ?`,
                    [Date.now()],
                );

                for (const vote of votes) {
                    await this.scheduleVote(vote, client);
                }

                return votes.length;
            },
            "加载和调度投票"
        );

        if (result.success) {
            logTime(`[定时任务] VoteScheduler 初始化完成，已加载 ${result.data} 个投票`);
        }
    }

    /**
     * 调度单个投票的状态更新
     * @param {Object} vote - 投票记录
     * @param {Object} client - Discord客户端
     */
    async scheduleVote(vote, client) {
        await ErrorHandler.handleService(
            async () => {
                const now = Date.now();

                // 获取并验证投票数据
                const parsedVote = await VoteModel.getVoteById(vote.id);
                if (!parsedVote?.threadId || !parsedVote?.messageId) {
                    throw new Error(`投票数据无效或缺少必要字段`);
                }

                // 存储投票状态
                this.votes.set(vote.id, parsedVote);

                this.clearVoteTimers(vote.id);

                // 设置结束时间定时器
                if (now < parsedVote.endTime) {
                    const endTime = new Date(parsedVote.endTime);
                    const endJob = schedule.scheduleJob(endTime, () => {
                        // 使用容错处理，避免单个投票失败影响整个系统
                        this._handleVoteEnd(vote.id, parsedVote, client);
                    });

                    this.jobs.set(`end_${vote.id}`, endJob);
                    logTime(`[定时任务] 已设置投票 ${vote.id} 的结束定时器，将在 ${endTime.toLocaleString()} 结束`);
                }
            },
            `调度投票 [ID: ${vote.id}]`,
            { throwOnError: true }
        );
    }

    /**
     * 处理投票结束
     * @private
     */
    async _handleVoteEnd(voteId, parsedVote, client) {
        await ErrorHandler.handleSilent(
            async () => {
                // 获取最新的投票状态，检查是否已经结束
                const currentVote = await VoteModel.getVoteById(voteId);
                if (!currentVote || currentVote.status === 'completed') {
                    logTime(`[定时任务] 投票 ${voteId} 已完成，跳过定时器结算`);
                    return;
                }

                const channel = await client.channels.fetch(parsedVote.threadId);
                if (!channel) {
                    logTime(`[定时任务] 无法获取频道 [ID: ${parsedVote.threadId}]`, true);
                    return;
                }

                const message = await channel.messages.fetch(parsedVote.messageId);
                if (!message) {
                    logTime(`[定时任务] 无法获取消息 [ID: ${parsedVote.messageId}]`, true);
                    return;
                }

                const { result, message: resultMessage } = await VoteService.executeVoteResult(
                    currentVote,
                    client,
                );

                // 获取最新的投票状态
                const finalVote = await VoteModel.getVoteById(voteId);

                // 更新消息显示结果
                await VoteService.updateVoteMessage(message, finalVote, {
                    result,
                    message: resultMessage,
                });

                // 清理投票状态
                this.votes.delete(voteId);
                this.clearVoteTimers(voteId);
            },
            `处理投票结束 [ID: ${voteId}]`
        );
    }

    /**
     * 清理指定投票的定时器
     * @param {number} voteId - 投票ID
     */
    clearVoteTimers(voteId) {
        // 使用可选链简化操作
        [`public_${voteId}`, `end_${voteId}`].forEach(jobKey => {
            this.jobs.get(jobKey)?.cancel();
            this.jobs.delete(jobKey);
        });
    }

    /**
     * 清理所有定时器和状态
     */
    cleanup() {
        for (const job of this.jobs.values()) {
            job.cancel();
        }
        this.jobs.clear();
        this.votes.clear();
        logTime('[定时任务] 已清理所有投票定时器和状态');
    }
}
