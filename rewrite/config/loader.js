/**
 * 配置加载模块
 * 负责加载和合并环境变量、全局配置、服务器配置
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { validateEnv, validateGlobalConfig, validateGuildConfig } from './schema.js';

/**
 * 加载并验证配置
 * @param {Object} options - 加载选项
 * @param {string} options.envPath - .env 文件路径
 * @param {string} options.configPath - config.json 文件路径
 * @param {string} options.guildsDir - guilds 配置目录路径
 * @param {boolean} options.validateOnly - 仅验证不加载
 * @returns {Object} 配置对象
 */
export function loadConfig(options = {}) {
    const {
        envPath = resolve(process.cwd(), '.env'),
        configPath = resolve(process.cwd(), 'rewrite/config/config.json'),
        guildsDir = resolve(process.cwd(), 'rewrite/config/guilds'),
        validateOnly = false
    } = options;

    // 1. 加载环境变量
    if (existsSync(envPath)) {
        loadDotenv({ path: envPath });
    }

    // 验证环境变量
    const envErrors = validateEnv(process.env);
    if (envErrors.length > 0) {
        throw new Error(`环境变量验证失败:\n  - ${envErrors.join('\n  - ')}`);
    }

    const token = process.env.DISCORD_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;
    const databaseUrl = process.env.DATABASE_URL;
    const nodeEnv = process.env.NODE_ENV || 'development';

    if (validateOnly) {
        return { token, clientId, databaseUrl, nodeEnv };
    }

    // 2. 加载全局配置
    if (!existsSync(configPath)) {
        throw new Error(`配置文件不存在: ${configPath}`);
    }

    let globalConfig;
    try {
        const configContent = readFileSync(configPath, 'utf8');
        globalConfig = JSON.parse(configContent);
    } catch (error) {
        throw new Error(`配置文件解析失败: ${error.message}`);
    }

    // 验证全局配置
    const configErrors = validateGlobalConfig(globalConfig);
    if (configErrors.length > 0) {
        throw new Error(`配置验证失败:\n  - ${configErrors.join('\n  - ')}`);
    }

    // 3. 处理数据库配置优先级（DATABASE_URL > config.json）
    if (databaseUrl && globalConfig.database) {
        globalConfig.database.connectionUrl = databaseUrl;
    }

    // 4. 构建最终配置对象
    const config = {
        token,
        nodeEnv,
        ...globalConfig,
        bot: {
            ...globalConfig.bot,
            clientId  // 从环境变量注入 clientId
        }
    };

    // 5. 加载服务器配置（懒加载，通过 getGuildConfig 获取）
    config.guildsDir = guildsDir;

    return config;
}

/**
 * 配置管理器类
 * 提供配置缓存和懒加载
 */
export class ConfigManager {
    constructor(globalConfig, logger = null) {
        this.globalConfig = globalConfig;
        this.guildConfigs = new Map();
        this.guildsDir = globalConfig.guildsDir;
        this.logger = logger;
    }

    /**
     * 获取全局配置
     * @returns {Object}
     */
    getGlobal() {
        return this.globalConfig;
    }

    /**
     * 加载指定服务器的配置文件
     * @private
     * @param {string} guildId - 服务器ID
     * @returns {Object|null} 服务器配置对象，不存在则返回null
     */
    _loadGuildConfigFile(guildId) {
        // 如果没有配置 guildsDir，返回 null
        if (!this.guildsDir) {
            return null;
        }

        const guildConfigPath = join(this.guildsDir, `${guildId}.json`);

        if (!existsSync(guildConfigPath)) {
            return null;
        }

        try {
            const configContent = readFileSync(guildConfigPath, 'utf8');
            const guildConfig = JSON.parse(configContent);

            // 验证服务器配置
            const errors = validateGuildConfig(guildConfig, guildId);
            if (errors.length > 0 && this.logger) {
                this.logger.warn({
                    msg: '[ConfigManager] 服务器配置验证警告',
                    guildId,
                    errors
                });
            }

            return guildConfig;
        } catch (error) {
            if (this.logger) {
                this.logger.error({
                    msg: '[ConfigManager] 加载服务器配置失败',
                    guildId,
                    error: error.message
                });
            }
            return null;
        }
    }

    /**
     * 加载所有服务器配置文件
     * @private
     * @returns {Map<string, Object>} 服务器ID到配置的映射
     */
    _loadAllGuildConfigFiles() {
        const configs = new Map();

        if (!existsSync(this.guildsDir)) {
            return configs;
        }

        const files = readdirSync(this.guildsDir);

        for (const file of files) {
            if (!file.endsWith('.json')) {
                continue;
            }

            const guildId = file.replace('.json', '');
            const config = this._loadGuildConfigFile(guildId);

            if (config) {
                configs.set(guildId, config);
            }
        }

        return configs;
    }

    /**
     * 获取指定服务器的配置（带缓存）
     * @param {string} guildId - 服务器ID
     * @returns {Object|null}
     */
    getGuild(guildId) {
        if (this.guildConfigs.has(guildId)) {
            return this.guildConfigs.get(guildId);
        }

        const config = this._loadGuildConfigFile(guildId);
        if (config) {
            this.guildConfigs.set(guildId, config);
        }

        return config;
    }

    /**
     * 重新加载指定服务器的配置（清除缓存）
     * @param {string} guildId - 服务器ID
     */
    reloadGuild(guildId) {
        this.guildConfigs.delete(guildId);
        return this.getGuild(guildId);
    }

    /**
     * 预加载所有服务器配置
     */
    preloadAllGuilds() {
        const configs = this._loadAllGuildConfigFiles();
        for (const [guildId, config] of configs) {
            this.guildConfigs.set(guildId, config);
        }
        return configs.size;
    }

    /**
     * 清除所有缓存
     */
    clearCache() {
        this.guildConfigs.clear();
    }
}

