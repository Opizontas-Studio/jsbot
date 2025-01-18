import { logTime } from './logger.js';

export class GuildManager {
    constructor() {
        this.guilds = new Map();
    }

    /**
     * 初始化服务器配置
     * @param {Object} config - 配置对象
     */
    initialize(config) {
        if (!config.guilds || typeof config.guilds !== 'object') {
            throw new Error('配置文件缺少guilds对象');
        }

        for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
            const automationConfig = guildConfig.automation || {};
            this.guilds.set(guildId, {
                ...guildConfig,
                automation: {
                    analysis: automationConfig.analysis || false,
                    cleanup: {
                        enabled: automationConfig.cleanup?.enabled || false,
                        threshold: automationConfig.cleanup?.threshold || 960
                    },
                    logThreadId: automationConfig.logThreadId,
                    whitelistedThreads: automationConfig.whitelistedThreads || []
                }
            });

            // 构建状态信息
            const features = [];
            if (automationConfig.analysis) features.push('已启用分析');
            if (automationConfig.cleanup?.enabled) features.push(`已启用清理(阈值:${automationConfig.cleanup.threshold || 960})`);
            
            logTime(`已加载服务器配置: ${guildId}${features.length ? ' (' + features.join(', ') + ')' : ''}`);
        }
    }

    /**
     * 获取服务器配置
     * @param {string} guildId - 服务器ID
     * @returns {Object|null} 服务器配置对象
     */
    getGuildConfig(guildId) {
        return this.guilds.get(guildId);
    }

    /**
     * 获取所有已配置的服务器ID
     * @returns {string[]} 服务器ID数组
     */
    getGuildIds() {
        return Array.from(this.guilds.keys());
    }
}

export default GuildManager; 