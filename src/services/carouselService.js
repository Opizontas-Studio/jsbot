import schedule from 'node-schedule';
import { logTime } from '../utils/logger.js';
import { getOrCreateMessage } from './threadAnalyzer.js';

// 轮播相关常量
const CAROUSEL_CONFIG = {
    PAGE_SIZE: 10,
    UPDATE_INTERVAL_SECONDS: 10,
    CRON_PATTERN: '*/10 * * * * *', // 每10秒执行一次
    EMBED_COLOR: 0x0099ff,
    TITLE: '950人以上关注的子区轮播',
    DESCRIPTION_BASE: '[【点此查看申请标准】](https://discord.com/channels/1291925535324110879/1374952785975443466/1374954348655804477)，满足条件的创作者可以到[【申请通道】](https://discord.com/channels/1291925535324110879/1374608096076500992)提交申请。现在也允许多人合作申请频道。',
};

/**
 * 符合条件子区轮播服务
 */
class CarouselService {
    constructor() {
        this.carousels = new Map(); // 存储各个服务器的轮播状态
        this.jobs = new Map(); // 存储轮播定时任务
    }

    /**
     * 启动符合条件子区的轮播显示
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {Array<Object>} qualifiedThreads - 符合条件的子区列表
     * @param {Object} messageIds - 消息ID配置对象
     */
    async startCarousel(channel, guildId, qualifiedThreads, messageIds) {
        try {
            // 停止现有的轮播
            this.stopCarousel(guildId);

            if (qualifiedThreads.length === 0) {
                return;
            }

            // 存储轮播状态
            const totalPages = Math.ceil(qualifiedThreads.length / CAROUSEL_CONFIG.PAGE_SIZE);

            this.carousels.set(guildId, {
                channel,
                qualifiedThreads,
                messageIds,
                totalPages,
                currentPage: 0,
                pageSize: CAROUSEL_CONFIG.PAGE_SIZE,
            });

            // 立即显示第一页
            await this.updateCarouselMessage(guildId);

            // 如果只有一页，不需要轮播
            if (totalPages <= 1) {
                return;
            }

            // 创建轮播任务
            const job = schedule.scheduleJob(CAROUSEL_CONFIG.CRON_PATTERN, async () => {
                try {
                    const carouselState = this.carousels.get(guildId);
                    if (!carouselState) {
                        return;
                    }

                    // 切换到下一页
                    carouselState.currentPage = (carouselState.currentPage + 1) % carouselState.totalPages;
                    await this.updateCarouselMessage(guildId);
                } catch (error) {
                    logTime(`[轮播] 更新轮播消息失败 [服务器 ${guildId}]: ${error.message}`, true);
                }
            });

            this.jobs.set(guildId, job);
            logTime(`[轮播] 已启动服务器 ${guildId} 的符合条件子区轮播，共 ${totalPages} 页，每${CAROUSEL_CONFIG.UPDATE_INTERVAL_SECONDS}秒切换`);
        } catch (error) {
            logTime(`[轮播] 启动轮播失败 [服务器 ${guildId}]: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新轮播消息内容
     * @param {string} guildId - 服务器ID
     */
    async updateCarouselMessage(guildId) {
        const carouselState = this.carousels.get(guildId);
        if (!carouselState) {
            return;
        }

        const { channel, qualifiedThreads, messageIds, totalPages, currentPage, pageSize } = carouselState;

        // 获取当前页的数据
        const startIndex = currentPage * pageSize;
        const currentPageThreads = qualifiedThreads.slice(startIndex, startIndex + pageSize);

        // 构建Embed
        const embed = {
            color: CAROUSEL_CONFIG.EMBED_COLOR,
            title: CAROUSEL_CONFIG.TITLE,
            description: [
                CAROUSEL_CONFIG.DESCRIPTION_BASE,
                totalPages > 1 ? `\n📄 第 ${currentPage + 1}/${totalPages} 页 (共 ${qualifiedThreads.length} 个子区，每${CAROUSEL_CONFIG.UPDATE_INTERVAL_SECONDS}秒自动切换)` : `\n📊 共 ${qualifiedThreads.length} 个子区`,
            ].join(''),
            timestamp: new Date(),
            fields: currentPageThreads.map((thread, index) => {
                const globalIndex = startIndex + index + 1;
                return {
                    name: `${globalIndex}. ${thread.name}${thread.error ? ' ⚠️' : ''} (${thread.memberCount}人关注)`,
                    value: [
                        `所属频道: ${thread.parentName}`,
                        `创作者: ${thread.creatorTag || '未知用户'}`,
                        `[🔗 链接](https://discord.com/channels/${guildId}/${thread.threadId})`,
                    ].join('\n'),
                    inline: false,
                };
            }),
        };

        // 获取或创建消息
        const message = await getOrCreateMessage(channel, 'top10', guildId, messageIds);
        await message.edit({ embeds: [embed] });
    }

    /**
     * 停止指定服务器的轮播
     * @param {string} guildId - 服务器ID
     */
    stopCarousel(guildId) {
        // 停止定时任务
        if (this.jobs.has(guildId)) {
            this.jobs.get(guildId).cancel();
            this.jobs.delete(guildId);
            logTime(`[轮播] 已停止服务器 ${guildId} 的轮播任务`);
        }

        // 清理状态
        this.carousels.delete(guildId);
    }

    /**
     * 停止所有轮播
     */
    stopAll() {
        for (const [guildId, job] of this.jobs) {
            job.cancel();
            logTime(`[轮播] 已停止服务器 ${guildId} 的轮播任务`);
        }
        this.jobs.clear();
        this.carousels.clear();
    }
}

// 创建单例实例
export const carouselService = new CarouselService();

/**
 * 启动符合条件子区的轮播显示（便捷函数）
 * @param {Object} channel - Discord频道对象
 * @param {string} guildId - 服务器ID
 * @param {Array<Object>} qualifiedThreads - 符合条件的子区列表
 * @param {Object} messageIds - 消息ID配置对象
 */
export const startQualifiedThreadsCarousel = async (channel, guildId, qualifiedThreads, messageIds) => {
    await carouselService.startCarousel(channel, guildId, qualifiedThreads, messageIds);
};
