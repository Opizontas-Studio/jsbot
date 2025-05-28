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

            // 验证必要的配置字段
            if (!guildConfig.serverType) {
                logTime(`警告: 服务器 ${guildId} 缺少 serverType 配置`, true);
            }
            if (!guildConfig.AdministratorRoleIds) {
                logTime(`警告: 服务器 ${guildId} 缺少 AdministratorRoleIds 配置`, true);
            }
            if (!guildConfig.ModeratorRoleIds || guildConfig.ModeratorRoleIds.length === 0) {
                logTime(`警告: 服务器 ${guildId} 缺少 ModeratorRoleIds 配置`, true);
            }

            // 创建服务器配置对象
            const serverConfig = {
                id: guildId, // string - Discord服务器ID
                serverType: guildConfig.serverType || '', // string - 服务器类型，'Main server' 或 'Sub server'
                moderationLogThreadId: guildConfig.moderationLogThreadId, // string - 管理日志频道ID
                threadLogThreadId: guildConfig.threadLogThreadId, // string - 帖子操作日志频道ID
                opinionMailThreadId: guildConfig.opinionMailThreadId, // string - 意见信箱和新闻投稿频道ID
                AdministratorRoleIds: guildConfig.AdministratorRoleIds || [], // string[] - 管理员角色ID数组
                ModeratorRoleIds: guildConfig.ModeratorRoleIds || [], // string[] - 版主角色ID数组
                eventsCategoryId: guildConfig.eventsCategoryId, // 赛事分类ID
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
                    WarnedRoleId: null, // string - 警告角色ID，从根级别移动到此处
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
                    channelId: guildConfig.monitor?.channelId || null,
                    messageId: guildConfig.monitor?.messageId || null,
                    roleMonitorCategoryId: guildConfig.monitor?.roleMonitorCategoryId || null,
                    senatorRoleChannelId: guildConfig.monitor?.senatorRoleChannelId || null,
                },
            };

            // 验证 FastGPT 配置
            if (serverConfig.fastgpt.enabled) {
                if (!serverConfig.fastgpt.endpoints || serverConfig.fastgpt.endpoints.length === 0) {
                    logTime(`警告: 服务器 ${guildId} 启用了 FastGPT 但未配置任何 endpoints`, true);
                    serverConfig.fastgpt.enabled = false; // 禁用，因为没有可用端点
                } else {
                    serverConfig.fastgpt.endpoints.forEach((ep, index) => {
                        if (!ep.url || !ep.key) {
                            logTime(
                                `警告: 服务器 ${guildId} FastGPT endpoint #${index + 1} 配置不完整 (缺少 url 或 key)`,
                                true,
                            );
                            // 你可以选择移除这个无效的endpoint或禁用整个功能
                        }
                    });
                    // 移除无效的endpoints
                    serverConfig.fastgpt.endpoints = serverConfig.fastgpt.endpoints.filter(ep => ep.url && ep.key);
                    if (serverConfig.fastgpt.endpoints.length === 0) {
                        logTime(`警告: 服务器 ${guildId} 所有 FastGPT endpoints 均无效，已禁用 FastGPT`, true);
                        serverConfig.fastgpt.enabled = false;
                    }
                }

                // 处理端点名称映射
                if (!serverConfig.fastgpt.endpointNames) {
                    serverConfig.fastgpt.endpointNames = {};
                }

                // 为没有名称的端点自动生成名称
                serverConfig.fastgpt.endpoints.forEach((ep, index) => {
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
