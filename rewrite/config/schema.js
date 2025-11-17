/**
 * 配置验证模块
 * 提供配置结构验证和类型检查
 */

// ==================== 验证辅助函数 ====================

/**
 * 验证辅助工具
 */
const validators = {
    /**
     * 验证是否为正数
     * @param {*} value - 待验证的值
     * @param {string} fieldName - 字段名称
     * @param {Array<string>} errors - 错误数组
     * @returns {boolean} 验证是否通过
     */
    isPositiveNumber(value, fieldName, errors) {
        if (value === undefined) return true;
        if (typeof value !== 'number' || value <= 0) {
            errors.push(`${fieldName} 必须是正数`);
            return false;
        }
        return true;
    },

    /**
     * 验证是否为数字
     * @param {*} value - 待验证的值
     * @param {string} fieldName - 字段名称
     * @param {Array<string>} errors - 错误数组
     * @returns {boolean} 验证是否通过
     */
    isNumber(value, fieldName, errors) {
        if (value === undefined) return true;
        if (typeof value !== 'number') {
            errors.push(`${fieldName} 必须是数字`);
            return false;
        }
        return true;
    },

    /**
     * 验证字符串是否非空
     * @param {*} value - 待验证的值
     * @param {string} fieldName - 字段名称
     * @param {Array<string>} errors - 错误数组
     * @returns {boolean} 验证是否通过
     */
    isNonEmptyString(value, fieldName, errors) {
        if (!value || typeof value !== 'string' || value.trim().length === 0) {
            errors.push(`${fieldName} 不能为空`);
            return false;
        }
        return true;
    },

    /**
     * 验证是否为有效的 Discord Snowflake ID
     * @param {*} value - 待验证的值
     * @param {string} fieldName - 字段名称
     * @param {Array<string>} errors - 错误数组
     * @returns {boolean} 验证是否通过
     */
    isSnowflake(value, fieldName, errors) {
        if (typeof value === 'string' && !/^\d{17,19}$/.test(value)) {
            errors.push(`${fieldName} 不是有效的Discord Snowflake ID`);
            return false;
        }
        return true;
    },

    /**
     * 验证是否在指定的枚举值中
     * @param {*} value - 待验证的值
     * @param {Array} enumValues - 允许的枚举值
     * @param {string} fieldName - 字段名称
     * @param {Array<string>} errors - 错误数组
     * @returns {boolean} 验证是否通过
     */
    isInEnum(value, enumValues, fieldName, errors) {
        if (value && !enumValues.includes(value)) {
            errors.push(`${fieldName} 必须是 ${enumValues.join(', ')} 之一`);
            return false;
        }
        return true;
    }
};

// ==================== 配置验证函数 ====================

/**
 * 验证全局配置结构
 * @param {Object} config - 配置对象
 * @returns {Array<string>} 错误信息数组，空数组表示验证通过
 */
export function validateGlobalConfig(config) {
    const errors = [];
    const { isPositiveNumber, isNumber, isInEnum } = validators;

    // 验证 bot 配置
    if (!config.bot) {
        errors.push('缺少必需的配置节: bot');
    } else {
        isInEnum(
            config.bot.logLevel,
            ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
            'bot.logLevel',
            errors
        );
        isNumber(config.bot.gracefulShutdownTimeout, 'bot.gracefulShutdownTimeout', errors);
    }

    // 验证 database 配置
    if (config.database?.postgres) {
        const pg = config.database.postgres;
        if (!pg.host) errors.push('database.postgres.host 不能为空');
        if (!pg.database) errors.push('database.postgres.database 不能为空');
        isNumber(pg.port, 'database.postgres.port', errors);
    }

    if (config.database?.sqlite && !config.database.sqlite.path) {
        errors.push('database.sqlite.path 不能为空');
    }

    // 验证 api 配置
    if (config.api?.rateLimit?.global) {
        const rl = config.api.rateLimit.global;
        isPositiveNumber(rl.maxRequests, 'api.rateLimit.global.maxRequests', errors);
        isPositiveNumber(rl.window, 'api.rateLimit.global.window', errors);
    }

    // 验证 queue 配置
    if (config.queue) {
        isPositiveNumber(config.queue.concurrency, 'queue.concurrency', errors);
        isPositiveNumber(config.queue.timeout, 'queue.timeout', errors);
    }

    return errors;
}

/**
 * 验证服务器配置结构
 * @param {Object} guildConfig - 服务器配置对象
 * @param {string} guildId - 服务器ID
 * @returns {Array<string>} 错误信息数组
 */
export function validateGuildConfig(guildConfig, guildId) {
    const errors = [];
    const { isSnowflake } = validators;

    if (!guildConfig) {
        errors.push(`服务器 ${guildId} 的配置为空`);
        return errors;
    }

    // 验证 guildId 匹配
    if (guildConfig.guildId && guildConfig.guildId !== guildId) {
        errors.push(`配置文件中的 guildId (${guildConfig.guildId}) 与文件名 (${guildId}) 不匹配`);
    }

    // 验证 roleIds
    if (guildConfig.roleIds) {
        for (const [key, value] of Object.entries(guildConfig.roleIds)) {
            if (Array.isArray(value)) {
                if (!value.every(id => typeof id === 'string')) {
                    errors.push(`roleIds.${key} 数组中包含非字符串元素`);
                }
            } else if (typeof value === 'string') {
                isSnowflake(value, `roleIds.${key}`, errors);
            } else if (typeof value !== 'object') {
                errors.push(`roleIds.${key} 类型错误`);
            }
        }
    }

    // 验证 channelIds
    if (guildConfig.channelIds) {
        for (const [key, value] of Object.entries(guildConfig.channelIds)) {
            isSnowflake(value, `channelIds.${key}`, errors);
        }
    }

    return errors;
}

/**
 * 验证环境变量
 * @param {Object} env - 环境变量对象
 * @returns {Array<string>} 错误信息数组
 */
export function validateEnv(env) {
    const errors = [];
    const { isNonEmptyString } = validators;

    isNonEmptyString(env.DISCORD_TOKEN, 'DISCORD_TOKEN', errors);
    isNonEmptyString(env.DISCORD_CLIENT_ID, 'DISCORD_CLIENT_ID', errors);

    // 验证 DATABASE_URL（可选）
    if (env.DATABASE_URL &&
        !env.DATABASE_URL.startsWith('postgresql://') &&
        !env.DATABASE_URL.startsWith('postgres://')) {
        errors.push('DATABASE_URL 必须是有效的PostgreSQL连接字符串');
    }

    // 验证 NODE_ENV
    validators.isInEnum(
        env.NODE_ENV,
        ['development', 'production', 'test'],
        'NODE_ENV',
        errors
    );

    return errors;
}
