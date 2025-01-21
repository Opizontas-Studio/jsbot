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

        logTime(`开始加载服务器配置，共 ${Object.keys(config.guilds).length} 个服务器`);
        for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
            const automationConfig = guildConfig.automation || {};
            
            // 验证必要的配置字段
            if (!guildConfig.moderationLogThreadId) {
                logTime(`警告: 服务器 ${guildId} 缺少 moderationLogThreadId 配置`, true);
            }
            if (!guildConfig.ModeratorRoleIds || guildConfig.ModeratorRoleIds.length === 0) {
                logTime(`警告: 服务器 ${guildId} 缺少 ModeratorRoleIds 配置`, true);
            }

            // 创建服务器配置对象
            const serverConfig = {
                id: guildId,
                moderationLogThreadId: guildConfig.moderationLogThreadId,
                AdministratorRoleIds: guildConfig.AdministratorRoleIds || [],
                ModeratorRoleIds: guildConfig.ModeratorRoleIds || [],
                WarnedRoleId: guildConfig.WarnedRoleId,
                automation: {
                    analysis: automationConfig.analysis || false,
                    cleanup: {
                        enabled: automationConfig.cleanup?.enabled || false,
                        threshold: automationConfig.cleanup?.threshold || 960
                    },
                    logThreadId: automationConfig.logThreadId,
                    whitelistedThreads: automationConfig.whitelistedThreads || []
                },
                roleApplication: guildConfig.roleApplication || {
                    enabled: false,
                    logThreadId: null,
                    creatorRoleThreadId: null,
                    creatorRoleId: null,
                    senatorRoleId: null,
                    senatorRoleForumId: null
                },
                courtSystem: guildConfig.courtSystem || {
                    enabled: false,
                    courtChannelId: null,
                    debateForumId: null,
                    senatorRoleId: null,
                    appealDuration: 259200000,
                    requiredSupports: 10
                }
            };

            this.guilds.set(guildId, serverConfig);

            // 构建状态信息
            const features = [];
            if (automationConfig.analysis) features.push('已启用分析');
            if (automationConfig.cleanup?.enabled) features.push(`已启用清理(阈值:${automationConfig.cleanup.threshold || 960})`);
            
            logTime(`已加载服务器配置: ${guildId}${features.length ? ' (' + features.join(', ') + ')' : ''}`);
        }
        
        logTime(`服务器配置加载完成，当前已配置 ${this.guilds.size} 个服务器`);
    }

    /**
     * 获取服务器配置
     * @param {string} guildId - 服务器ID
     * @returns {Object|null} 服务器配置对象
     */
    getGuildConfig(guildId) {
        if (!guildId) {
            logTime(`尝试获取配置时 guildId 为空`, true);
            return null;
        }
        
        const config = this.guilds.get(guildId);
        if (!config) {
            logTime(`服务器 ${guildId} 的配置不存在`, true);
            return null;
        }
        
        return config;
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