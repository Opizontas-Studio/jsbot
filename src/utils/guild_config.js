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
	            id: guildId, // string - Discord服务器ID
	            serverType: guildConfig.serverType || '', // string - 服务器类型，'Main server' 或 'Sub server'
	            moderationLogThreadId: guildConfig.moderationLogThreadId, // string - 管理日志频道ID
	            AdministratorRoleIds: guildConfig.AdministratorRoleIds || [], // string[] - 管理员角色ID数组
	            ModeratorRoleIds: guildConfig.ModeratorRoleIds || [], // string[] - 版主角色ID数组
	            WarnedRoleId: guildConfig.WarnedRoleId, // string - 警告角色ID
	            automation: {
	                analysis: automationConfig.analysis || false, // boolean - 是否启用自动分析
	                cleanup: {
	                    enabled: automationConfig.cleanup?.enabled || false, // boolean - 是否启用自动清理
	                    threshold: automationConfig.cleanup?.threshold || 960, // number - 清理阈值（分钟）
	                },
	                logThreadId: automationConfig.logThreadId, // string - 自动化日志频道ID
	                whitelistedThreads: automationConfig.whitelistedThreads || [], // string[] - 白名单主题ID数组
	            },
	            roleApplication: guildConfig.roleApplication || {
	                enabled: false, // boolean - 是否启用角色申请系统
	                logThreadId: null, // string | null - 角色申请日志频道ID
	                creatorRoleThreadId: null, // string | null - 创作者角色主题ID
	                creatorRoleId: null, // string | null - 创作者角色ID
	                senatorRoleId: null, // string | null - 参议员角色ID
	                senatorRoleForumId: null, // string | null - 参议员论坛ID
	            },
	            courtSystem: guildConfig.courtSystem || {
	                enabled: false, // boolean - 是否启用法庭系统
	                courtChannelId: null, // string | null - 法庭频道ID
	                debateForumId: null, // string | null - 辩论论坛ID
	                senatorRoleId: null, // string | null - 参议员角色ID
	                appealDuration: 259200000, // number - 上诉持续时间（毫秒）
	                summitDuration: 604800000, // number - 议事持续时间（毫秒，7天）
	                requiredSupports: 10, // number - 所需支持票数
	                debateTagId: null, // string | null - 辩论标签ID
	                appealDebateRoleId: null, // string | null - 辩诉通行身份组ID
	            },
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
	        logTime('尝试获取配置时 guildId 为空', true);
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