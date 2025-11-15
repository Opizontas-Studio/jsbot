import { promises as fs } from 'fs';
import { join } from 'path';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { getOrCreateMessage } from '../thread/threadAnalyzer.js';
import { BaseCarouselService } from './BaseCarouselService.js';

const CONFIG_PATH = join(process.cwd(), 'data', 'carouselConfig.json');

/**
 * 符合条件子区轮播服务
 */
export class QualifiedThreadsCarousel extends BaseCarouselService {
    constructor() {
        super();
        this.config = null;
    }

    /**
     * 加载配置
     */
    async loadConfig() {
        return await ErrorHandler.handleSilent(
            async () => {
                const data = await fs.readFile(CONFIG_PATH, 'utf8');
                const config = JSON.parse(data);
                this.config = config.qualifiedThreads;
                return this.config;
            },
            '加载轮播配置',
            {
                pageSize: 10,
                updateIntervalSeconds: 10,
                embedColor: 0x0099ff,
                title: '950人以上关注的子区轮播',
                descriptionBase: '',
            }
        );
    }

    /**
     * 启动符合条件子区的轮播显示
     * @param {Object} channel - Discord频道对象
     * @param {string} guildId - 服务器ID
     * @param {Array<Object>} qualifiedThreads - 符合条件的子区列表
     * @param {Object} messageIds - 消息ID配置对象
     */
    async startQualifiedThreadsCarousel(channel, guildId, qualifiedThreads, messageIds) {
        // 加载配置
        if (!this.config) {
            await this.loadConfig();
        }

        await this.startCarousel(guildId, {
            channel,
            data: qualifiedThreads,
            messageIds,
            pageSize: this.config.pageSize,
            updateIntervalSeconds: this.config.updateIntervalSeconds,
            guildId,
        });
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

        const { channel, messageIds, totalPages, currentPage, pageSize } = carouselState;
        const qualifiedThreads = carouselState.data;

        // 获取当前页的数据
        const currentPageThreads = this.getCurrentPageData(guildId);

        // 构建Embed
        const embed = {
            color: this.config.embedColor,
            title: this.config.title,
            description: [
                this.config.descriptionBase,
                totalPages > 1
                    ? `\n📄 第 ${currentPage + 1}/${totalPages} 页 (共 ${qualifiedThreads.length} 个子区，每${this.config.updateIntervalSeconds}秒自动切换)`
                    : `\n📊 共 ${qualifiedThreads.length} 个子区`,
            ].join(''),
            timestamp: new Date(),
            fields: currentPageThreads.map((thread, index) => {
                const startIndex = currentPage * pageSize;
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
}

