import schedule from 'node-schedule';
import { logTime } from '../../utils/logger.js';

/**
 * 轮播服务基类
 */
export class BaseCarouselService {
    constructor() {
        this.carousels = new Map(); // 存储轮播状态: key -> state
        this.jobs = new Map(); // 存储定时任务: key -> job
    }

    /**
     * 启动轮播
     * @param {string} key - 轮播唯一标识（通常是 guildId 或 guildId-channelId）
     * @param {Object} options - 轮播配置选项
     * @returns {Promise<void>}
     */
    async startCarousel(key, options) {
        try {
            // 停止现有的轮播
            this.stopCarousel(key);

            if (!options.data || options.data.length === 0) {
                return;
            }

            // 计算总页数
            const totalPages = Math.ceil(options.data.length / options.pageSize);

            // 存储轮播状态
            const carouselState = {
                ...options,
                totalPages,
                currentPage: 0,
            };

            this.carousels.set(key, carouselState);

            // 立即显示第一页
            await this.updateCarouselMessage(key);

            // 如果只有一页，不需要轮播
            if (totalPages <= 1) {
                logTime(`[轮播] ${key} 只有一页，无需启动轮播任务`);
                return;
            }

            // 创建轮播任务
            const cronPattern = `*/${options.updateIntervalSeconds} * * * * *`;
            const job = schedule.scheduleJob(cronPattern, async () => {
                try {
                    const state = this.carousels.get(key);
                    if (!state) {
                        return;
                    }

                    // 切换到下一页
                    state.currentPage = (state.currentPage + 1) % state.totalPages;
                    await this.updateCarouselMessage(key);
                } catch (error) {
                    logTime(`[轮播] 更新轮播消息失败 [${key}]: ${error.message}`, true);
                }
            });

            this.jobs.set(key, job);
            logTime(`[轮播] 已启动 ${key} 的轮播，共 ${totalPages} 页，每 ${options.updateIntervalSeconds} 秒切换`);
        } catch (error) {
            logTime(`[轮播] 启动轮播失败 [${key}]: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新轮播消息内容（需要子类实现）
     * @param {string} key - 轮播唯一标识
     * @returns {Promise<void>}
     */
    async updateCarouselMessage(key) {
        throw new Error('updateCarouselMessage() must be implemented by subclass');
    }

    /**
     * 获取轮播状态
     * @param {string} key - 轮播唯一标识
     * @returns {Object|undefined} 轮播状态对象
     */
    getCarouselState(key) {
        return this.carousels.get(key);
    }

    /**
     * 停止指定轮播
     * @param {string} key - 轮播唯一标识
     */
    stopCarousel(key) {
        // 停止定时任务
        if (this.jobs.has(key)) {
            this.jobs.get(key).cancel();
            this.jobs.delete(key);
            logTime(`[轮播] 已停止 ${key} 的轮播任务`);
        }

        // 清理状态
        this.carousels.delete(key);
    }

    /**
     * 停止所有轮播
     */
    stopAll() {
        for (const [key, job] of this.jobs) {
            job.cancel();
            logTime(`[轮播] 已停止 ${key} 的轮播任务`);
        }
        this.jobs.clear();
        this.carousels.clear();
    }

    /**
     * 获取当前页的数据
     * @param {string} key - 轮播唯一标识
     * @returns {Array} 当前页的数据数组
     */
    getCurrentPageData(key) {
        const state = this.carousels.get(key);
        if (!state) {
            return [];
        }

        const startIndex = state.currentPage * state.pageSize;
        return state.data.slice(startIndex, startIndex + state.pageSize);
    }
}

