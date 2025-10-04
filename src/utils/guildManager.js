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

        let mainServerCount = 0;

        for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
            const automationConfig = guildConfig.automation || {};

            // 验证必要的配置字段
            this.validateGuildConfig(guildId, guildConfig);

            // 统计主服务器数量
            if (guildConfig.serverType === 'Main server') {
                mainServerCount++;
            }

            // 创建服务器配置对象
            const serverConfig = {
                id: guildId, // string - Discord服务器ID
                serverType: guildConfig.serverType || '', // string - 服务器类型，'Main server' 或 'Sub server'
                moderationLogThreadId: guildConfig.moderationLogThreadId, // string - 管理日志频道ID
                threadLogThreadId: guildConfig.threadLogThreadId, // string - 帖子操作日志频道ID
                opinionMailThreadId: guildConfig.opinionMailThreadId, // string - 意见信箱频道ID
                AdministratorRoleIds: guildConfig.AdministratorRoleIds || [], // string[] - 管理员角色ID数组
                ModeratorRoleIds: guildConfig.ModeratorRoleIds || [], // string[] - 版主角色ID数组
                eventsCategoryId: guildConfig.eventsCategoryId, // 赛事分类ID
                blacklistRoleId: guildConfig.blacklistRoleId || null, // string | null - 黑名单角色ID
                automation: {
                    mode: automationConfig.mode || 'disabled', // string - 子区管理模式：'analysis'、'cleanup'或'disabled'
                    threshold: automationConfig.threshold || 960, // number - 清理阈值
                    logThreadId: automationConfig.logThreadId, // string - 自动化日志频道ID
                    whitelistedThreads: automationConfig.whitelistedThreads || [], // string[] - 白名单主题ID数组
                },
                roleApplication: guildConfig.roleApplication || {
                    logThreadId: null, // string | null - 角色申请日志频道ID
                    creatorRoleId: null, // string | null - 创作者角色ID
                    volunteerRoleId: null, // string | null - 志愿者角色ID
                    senatorRoleId: null, // string | null - 参议员角色ID
                    appealDebateRoleId: null, // string | null - 辩诉通行角色ID
                    QAerRoleId: null, // string | null - 答题员角色ID
                    senatorRoleForumId: null, // string | null - 参议员论坛ID
                    WarnedRoleId: null, // string - 警告角色ID
                },
                fastgpt: guildConfig.fastgpt || {
                    enabled: false,
                    endpoints: [], // 默认为空数组
                    endpointNames: {}, // 端点名称映射
                },
                courtSystem: guildConfig.courtSystem || {
                    enabled: false,
                    courtChannelId: null,
                    motionChannelId: null,
                    debateChannelId: null,
                    appealDuration: 259200000,
                    summitDuration: 604800000,
                    requiredSupports: 20,
                    debateTagId: null,
                    motionTagId: null,
                    voteDuration: 86400000, // 默认1天后结束
                },
                monitor: {
                    enabled: guildConfig.monitor?.enabled || false,
                    roleMonitorCategoryId: guildConfig.monitor?.roleMonitorCategoryId || null,
                    monitorChannelId: guildConfig.monitor?.monitorChannelId || null,
                    monitoredRoleId: guildConfig.monitor?.monitoredRoleId || null,
                    roleDisplayName: guildConfig.monitor?.roleDisplayName || '角色',
                },
            };

            // FastGPT配置处理（移到初始化后单独处理）
            if (serverConfig.fastgpt.enabled) {
                this.processFastGPTConfig(guildId, serverConfig);
            }

            this.guilds.set(guildId, serverConfig);

            // 构建状态信息
            const features = [];
            if (serverConfig.automation.mode === 'analysis') {
                features.push('已启用分析');
            } else if (serverConfig.automation.mode === 'cleanup') {
                features.push(`已启用清理(阈值:${serverConfig.automation.threshold})`);
            }

            logTime(`[系统启动] 已加载服务器配置: ${guildId}${features.length ? ' (' + features.join(', ') + ')' : ''}`);
        }

        // 验证主服务器配置
        this.validateMainServerSetup(mainServerCount);
    }

    /**
     * 重置并重新加载配置
     * @param {Object} config - 新的配置对象
     * @returns {Object} 包含添加、更新和移除的服务器ID数组
     */
    resetConfig(config) {
        if (!config.guilds || typeof config.guilds !== 'object') {
            throw new Error('配置文件缺少guilds对象');
        }

        const oldGuildIds = new Set(this.guilds.keys());
        const newGuildIds = new Set(Object.keys(config.guilds));

        // 计算差异
        const added = [...newGuildIds].filter(id => !oldGuildIds.has(id));
        const removed = [...oldGuildIds].filter(id => !newGuildIds.has(id));
        const updated = [...newGuildIds].filter(id => oldGuildIds.has(id));

        // 清空现有配置
        this.guilds.clear();

        // 重新加载所有配置
        this.initialize(config);

        // 返回变更摘要
        return {
            added,
            removed,
            updated,
            total: this.guilds.size,
        };
    }

    /**
     * 获取服务器配置
     * @param {string} guildId - 服务器ID
     * @returns {Object} 服务器配置对象（启动时已验证，保证存在）
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

    /**
     * 获取主服务器配置
     * @returns {Object} 主服务器配置对象（启动时已验证，保证存在）
     */
    getMainServerConfig() {
        for (const config of this.guilds.values()) {
            if (config.serverType === 'Main server') {
                return config;
            }
        }
        // 这里不应该到达，因为启动时已验证过主服务器存在
        throw new Error('系统错误：找不到主服务器配置');
    }

    /**
     * 获取主服务器ID
     * @returns {string} 主服务器ID（启动时已验证，保证存在）
     */
    getMainServerId() {
        return this.getMainServerConfig().id;
    }

    /**
     * 验证单个服务器配置的完整性
     * @private
     * @param {string} guildId - 服务器ID
     * @param {Object} guildConfig - 服务器配置对象
     */
    validateGuildConfig(guildId, guildConfig) {
        const errors = [];
        const warnings = [];

        // 必需字段验证
        if (!guildConfig.serverType) {
            errors.push('缺少 serverType 配置');
        } else if (!['Main server', 'Sub server'].includes(guildConfig.serverType)) {
            errors.push(`serverType 必须为 'Main server' 或 'Sub server'，当前值: ${guildConfig.serverType}`);
        }

        if (!guildConfig.AdministratorRoleIds || !Array.isArray(guildConfig.AdministratorRoleIds) || guildConfig.AdministratorRoleIds.length === 0) {
            errors.push('缺少 AdministratorRoleIds 配置或配置为空数组');
        }

        if (!guildConfig.ModeratorRoleIds || !Array.isArray(guildConfig.ModeratorRoleIds) || guildConfig.ModeratorRoleIds.length === 0) {
            errors.push('缺少 ModeratorRoleIds 配置或配置为空数组');
        }

        // 主服务器特有验证
        if (guildConfig.serverType === 'Main server') {
            if (!guildConfig.opinionMailThreadId) {
                warnings.push('主服务器未配置 opinionMailThreadId，意见信箱功能将不可用');
            }

            // 法庭系统验证
            if (guildConfig.courtSystem?.enabled) {
                const courtRequiredFields = ['courtChannelId', 'motionChannelId', 'debateChannelId', 'debateTagId', 'motionTagId'];
                for (const field of courtRequiredFields) {
                    if (!guildConfig.courtSystem[field]) {
                        errors.push(`启用法庭系统但缺少 courtSystem.${field} 配置`);
                    }
                }
            }

            // 角色申请系统验证（如果使用）
            if (guildConfig.roleApplication) {
                const roleFields = ['creatorRoleId', 'volunteerRoleId', 'senatorRoleId', 'appealDebateRoleId', 'QAerRoleId', 'WarnedRoleId'];
                const missingRoles = roleFields.filter(field => !guildConfig.roleApplication[field]);
                if (missingRoles.length > 0) {
                    warnings.push(`角色申请系统缺少配置: ${missingRoles.join(', ')}`);
                }
            }

            // 监控系统验证
            if (guildConfig.monitor?.enabled) {
                if (!guildConfig.monitor.roleMonitorCategoryId) {
                    errors.push('启用监控系统但缺少 monitor.roleMonitorCategoryId 配置');
                }
                if (!guildConfig.monitor.monitoredRoleId) {
                    errors.push('启用监控系统但缺少 monitor.monitoredRoleId 配置');
                }
            }

        }

        // 自动化系统验证
        if (guildConfig.automation?.mode && guildConfig.automation.mode !== 'disabled') {
            if (!guildConfig.automation.logThreadId) {
                warnings.push(`启用自动化系统(${guildConfig.automation.mode})但缺少 automation.logThreadId 配置`);
            }
        }

        // 输出验证结果
        if (errors.length > 0) {
            const errorMsg = `服务器 ${guildId} 配置错误: ${errors.join('; ')}`;
            logTime(errorMsg, true);
            throw new Error(errorMsg);
        }

        if (warnings.length > 0) {
            warnings.forEach(warning => {
                logTime(`警告: 服务器 ${guildId} - ${warning}`, true);
            });
        }
    }

    /**
     * 验证主服务器设置
     * @private
     * @param {number} mainServerCount - 主服务器数量
     */
    validateMainServerSetup(mainServerCount) {
        if (mainServerCount === 0) {
            const errorMsg = '配置错误: 必须至少有一个服务器配置为 "Main server"';
            logTime(errorMsg, true);
            throw new Error(errorMsg);
        }

        if (mainServerCount > 1) {
            const errorMsg = `配置错误: 只能有一个服务器配置为 "Main server"，当前有 ${mainServerCount} 个`;
            logTime(errorMsg, true);
            throw new Error(errorMsg);
        }

        logTime(`[系统启动] 主服务器配置验证通过 (${mainServerCount} 个主服务器)`);
    }

    /**
     * 处理FastGPT配置
     * @private
     * @param {string} guildId - 服务器ID
     * @param {Object} serverConfig - 服务器配置对象
     */
    processFastGPTConfig(guildId, serverConfig) {
        if (!serverConfig.fastgpt.endpoints || serverConfig.fastgpt.endpoints.length === 0) {
            logTime(`警告: 服务器 ${guildId} 启用了 FastGPT 但未配置任何 endpoints`, true);
            serverConfig.fastgpt.enabled = false; // 禁用，因为没有可用端点
            return;
        }

        // 验证并过滤无效的endpoints
        const validEndpoints = [];
        serverConfig.fastgpt.endpoints.forEach((ep, index) => {
            if (!ep.url || !ep.key) {
                logTime(
                    `警告: 服务器 ${guildId} FastGPT endpoint #${index + 1} 配置不完整 (缺少 url 或 key)`,
                    true,
                );
            } else {
                validEndpoints.push(ep);
            }
        });

        // 更新有效的endpoints
        serverConfig.fastgpt.endpoints = validEndpoints;

        if (validEndpoints.length === 0) {
            logTime(`警告: 服务器 ${guildId} 所有 FastGPT endpoints 均无效，已禁用 FastGPT`, true);
            serverConfig.fastgpt.enabled = false;
            return;
        }

        // 处理端点名称映射
        if (!serverConfig.fastgpt.endpointNames) {
            serverConfig.fastgpt.endpointNames = {};
        }

        // 为没有名称的端点自动生成名称
        validEndpoints.forEach((ep, index) => {
            try {
                const url = new URL(ep.url);
                const domainKey = `${url.protocol}//${url.hostname}`;

                // 如果没有为此域名设置名称，自动生成一个
                if (!serverConfig.fastgpt.endpointNames[domainKey]) {
                    // 使用域名的第一部分作为默认名称
                    const defaultName =
                        url.hostname.split('.')[0].charAt(0).toUpperCase() +
                        url.hostname.split('.')[0].slice(1);
                    serverConfig.fastgpt.endpointNames[domainKey] = `端点${index + 1} (${defaultName})`;
                }
            } catch (error) {
                // URL解析错误，使用默认名称
                serverConfig.fastgpt.endpointNames[ep.url] = `端点${index + 1}`;
            }
        });

        logTime(`[系统启动] 服务器 ${guildId} FastGPT 配置处理完成，有效端点: ${validEndpoints.length} 个`);
    }
}

export default GuildManager;
