import schedule from 'node-schedule';
import { dbManager } from '../sqlite/dbManager.js';
import PunishmentService from '../services/punishmentService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 处罚到期调度器
 */
export class PunishmentScheduler {
    constructor() {
        this.jobs = new Map();
    }

    /**
     * 初始化处罚调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        const result = await ErrorHandler.handleService(
            async () => {
                const punishments = await dbManager.safeExecute(
                    'all',
                    `SELECT * FROM punishments
                    WHERE status = 'active'
                    AND (
                        duration > 0 OR
                        warningDuration > 0 OR
                        (type IN ('softban', 'warning') AND warningDuration IS NOT NULL)
                    )`,
                    [],
                );

                // 处理返回的数据
                const activePunishments = punishments.map(p => ({
                    ...p,
                    keepMessages: Boolean(p.keepMessages),
                    duration: Number(p.duration),
                    warningDuration: p.warningDuration ? Number(p.warningDuration) : null,
                    syncedServers: JSON.parse(p.syncedServers || '[]'),
                }));

                // 调度处罚到期处理
                for (const punishment of activePunishments) {
                    await this.schedulePunishment(punishment, client);
                }

                return activePunishments.length;
            },
            "加载和调度处罚"
        );

        if (result.success) {
            logTime(`[处罚系统] [定时任务] PunishmentScheduler 初始化完成，已加载 ${result.data} 个处罚`);
        }
    }

    /**
     * 调度单个处罚的到期处理
     * @param {Object} punishment - 处罚记录
     * @param {Object} client - Discord客户端
     */
    async schedulePunishment(punishment, client) {
        await ErrorHandler.handleService(
            async () => {
                // 计算到期时间
                const durationExpiry = punishment.duration > 0 ? punishment.createdAt + punishment.duration : 0;
                const warningExpiry = punishment.warningDuration > 0 ? punishment.createdAt + punishment.warningDuration : 0;
                const expiryTime = new Date(Math.max(durationExpiry, warningExpiry));

                if (expiryTime.getTime() > 0) {
                    const job = schedule.scheduleJob(expiryTime, () => {
                        // 使用容错处理，避免单个处罚失败影响整个系统
                        ErrorHandler.handleSilent(
                            async () => await PunishmentService.handleExpiry(client, punishment),
                            `处罚 ${punishment.id} 到期处理`
                        );
                    });

                    logTime(`[处罚系统] [定时任务] 已调度处罚 ${punishment.id} 的到期处理，将在 ${expiryTime.toLocaleString()} 执行`);
                    this.jobs.set(punishment.id, job);
                }
            },
            `调度处罚 [ID: ${punishment.id}]`,
            { throwOnError: true }
        );
    }

    /**
     * 清理所有定时器
     */
    cleanup() {
        for (const job of this.jobs.values()) {
            job.cancel();
        }
        this.jobs.clear();
        logTime('[处罚系统] [定时任务] 已清理所有处罚到期定时器');
    }
}
