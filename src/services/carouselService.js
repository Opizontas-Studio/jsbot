import { ChannelCarousel } from './carousel/ChannelCarousel.js';
import { QualifiedThreadsCarousel } from './carousel/QualifiedThreadsCarousel.js';

/**
 * 轮播服务管理器
 * 统一管理多种类型的轮播服务
 */
class CarouselServiceManager {
    constructor() {
        this.qualifiedThreadsCarousel = new QualifiedThreadsCarousel();
        this.channelCarousel = new ChannelCarousel();
    }

    /**
     * 获取符合条件子区轮播服务
     */
    getQualifiedThreadsCarousel() {
        return this.qualifiedThreadsCarousel;
    }

    /**
     * 获取频道轮播服务
     */
    getChannelCarousel() {
        return this.channelCarousel;
    }

    /**
     * 停止所有轮播
     */
    stopAll() {
        this.qualifiedThreadsCarousel.stopAll();
        this.channelCarousel.stopAll();
    }
}

// 创建单例实例
export const carouselServiceManager = new CarouselServiceManager();

/**
 * 启动符合条件子区的轮播显示（便捷函数）
 * @param {Object} channel - Discord频道对象
 * @param {string} guildId - 服务器ID
 * @param {Array<Object>} qualifiedThreads - 符合条件的子区列表
 * @param {Object} messageIds - 消息ID配置对象
 */
export const startQualifiedThreadsCarousel = async (channel, guildId, qualifiedThreads, messageIds) => {
    await carouselServiceManager.getQualifiedThreadsCarousel().startQualifiedThreadsCarousel(
        channel,
        guildId,
        qualifiedThreads,
        messageIds
    );
};
