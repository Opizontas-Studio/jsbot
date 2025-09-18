import schedule from 'node-schedule';
import { ProcessModel } from '../db/models/processModel.js';
import CourtService from '../services/courtService.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * 流程到期调度器
 */
export class ProcessScheduler {
    constructor() {
        this.jobs = new Map();
    }

    /**
     * 初始化流程调度器
     * @param {Object} client - Discord客户端
     */
    async initialize(client) {
        const result = await ErrorHandler.handleService(
            async () => {
                const processes = await ProcessModel.getAllProcesses(false);
                for (const process of processes) {
                    await this.scheduleProcess(process, client);
                }
                return processes.length;
            },
            "加载和调度流程"
        );

        if (result.success) {
            logTime(`[定时任务] ProcessScheduler 初始化完成，已加载 ${result.data} 个流程`);
        }
    }

    /**
     * 调度单个流程的到期处理
     * @param {Object} process - 流程记录
     * @param {Object} client - Discord客户端
     */
    async scheduleProcess(process, client) {
        await ErrorHandler.handleService(
            async () => {
                const now = Date.now();
                const expiryTime = new Date(process.expireAt);

                // 清除已存在的任务
                this.jobs.get(process.id)?.cancel();
                this.jobs.delete(process.id);

                if (expiryTime.getTime() <= now) {
                    // 已过期，直接处理
                    await CourtService.handleProcessExpiry(process, client);
                } else {
                    // 设置定时任务
                    const job = schedule.scheduleJob(expiryTime, () => {
                        // 使用容错处理，避免单个流程失败影响整个系统
                        ErrorHandler.handleSilent(
                            async () => {
                                // 检查流程状态
                                const currentProcess = await ProcessModel.getProcessById(process.id);
                                if (currentProcess?.status === 'completed') {
                                    logTime(`[定时任务] 流程 ${process.id} 已完成，跳过到期处理`);
                                    return;
                                }
                                await CourtService.handleProcessExpiry(process, client);
                                this.jobs.delete(process.id);
                            },
                            `流程 ${process.id} 到期处理`
                        );
                    });

                    this.jobs.set(process.id, job);
                    logTime(`[定时任务] 已调度流程 ${process.id} 的到期处理，将在 ${expiryTime.toLocaleString()} 执行`);
                }
            },
            "调度流程",
            { throwOnError: true }
        );
    }

    /**
     * 取消流程的定时器
     * @param {number} processId - 流程ID
     */
    cancelProcess(processId) {
        const hadJob = this.jobs.has(processId);
        this.jobs.get(processId)?.cancel();
        this.jobs.delete(processId);

        if (hadJob) {
            logTime(`[定时任务] 已取消流程 ${processId} 的定时器`);
        }
    }

    /**
     * 清理所有定时器
     */
    cleanup() {
        for (const job of this.jobs.values()) {
            job.cancel();
        }
        this.jobs.clear();
        logTime('[定时任务] 已清理所有流程到期定时器');
    }
}
