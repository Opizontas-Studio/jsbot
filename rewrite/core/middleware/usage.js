import { VALIDATORS } from './usageValidators.js';

/**
 * Usage 中间件
 * 验证交互的使用场景是否符合要求
 *
 * 支持的配置格式：
 * 1. 简单数组（AND 逻辑）：
 *    usage: ['inGuild', 'inThread']
 *
 * 2. 对象形式（支持复杂逻辑）：
 *    usage: {
 *      all: ['inGuild', 'inThread'],  // 必须全部满足（AND）
 *      any: ['inDM', 'inGuild'],      // 至少满足一个（OR）
 *      not: ['targetIsBot']            // 必须不满足（NOT）
 *    }
 */
export function usageMiddleware(logger) {
    return async (ctx, next, config) => {
        // 没有配置 usage，直接放行
        if (!config.usage) {
            return await next();
        }

        // 验证 usage 配置
        const validationResult = validateUsage(ctx, config.usage);

        if (!validationResult.valid) {
            logger.debug({
                msg: 'Usage 验证失败',
                userId: ctx.user.id,
                commandName: ctx.interaction.commandName || ctx.interaction.customId,
                reason: validationResult.reason,
                failedCondition: validationResult.failedCondition
            });

            await ctx.info(validationResult.reason, false);
            return;
        }

        logger.debug({
            msg: 'Usage 验证通过',
            userId: ctx.user.id
        });

        await next();
    };
}

/**
 * 验证 usage 配置
 * @param {Context} ctx - 上下文对象
 * @param {Array|Object} usage - usage 配置
 * @returns {{ valid: boolean, reason: string, failedCondition?: string }}
 */
function validateUsage(ctx, usage) {
    // 简单数组形式（AND 逻辑）
    if (Array.isArray(usage)) {
        return validateAll(ctx, usage);
    }

    // 对象形式（支持复杂逻辑）
    if (typeof usage === 'object') {
        // 先验证 NOT 条件
        if (usage.not) {
            const notResult = validateNot(ctx, usage.not);
            if (!notResult.valid) {
                return notResult;
            }
        }

        // 验证 ALL 条件（AND）
        if (usage.all) {
            const allResult = validateAll(ctx, usage.all);
            if (!allResult.valid) {
                return allResult;
            }
        }

        // 验证 ANY 条件（OR）
        if (usage.any) {
            const anyResult = validateAny(ctx, usage.any);
            if (!anyResult.valid) {
                return anyResult;
            }
        }

        return { valid: true, reason: '' };
    }

    // 不支持的格式
    return {
        valid: false,
        reason: 'Usage 配置格式错误',
        failedCondition: 'invalid_format'
    };
}

/**
 * 验证所有条件都满足（AND）
 * @param {Context} ctx - 上下文对象
 * @param {Array<string>} conditions - 条件数组
 * @returns {{ valid: boolean, reason: string, failedCondition?: string }}
 */
function validateAll(ctx, conditions) {
    if (!Array.isArray(conditions)) {
        return {
            valid: false,
            reason: 'Usage 配置格式错误：all 必须是数组',
            failedCondition: 'invalid_format'
        };
    }

    for (const condition of conditions) {
        const result = executeValidator(ctx, condition);
        if (!result.valid) {
            return {
                valid: false,
                reason: result.reason,
                failedCondition: condition
            };
        }
    }

    return { valid: true, reason: '' };
}

/**
 * 验证至少有一个条件满足（OR）
 * @param {Context} ctx - 上下文对象
 * @param {Array<string>} conditions - 条件数组
 * @returns {{ valid: boolean, reason: string, failedCondition?: string }}
 */
function validateAny(ctx, conditions) {
    if (!Array.isArray(conditions)) {
        return {
            valid: false,
            reason: 'Usage 配置格式错误：any 必须是数组',
            failedCondition: 'invalid_format'
        };
    }

    if (conditions.length === 0) {
        return { valid: true, reason: '' };
    }

    const reasons = [];
    for (const condition of conditions) {
        const result = executeValidator(ctx, condition);
        if (result.valid) {
            return { valid: true, reason: '' };
        }
        reasons.push(result.reason);
    }

    // 所有条件都不满足
    return {
        valid: false,
        reason: `需要满足以下任一条件：${reasons.join('；或 ')}`,
        failedCondition: 'any_failed'
    };
}

/**
 * 验证条件不满足（NOT）
 * @param {Context} ctx - 上下文对象
 * @param {Array<string>|string} conditions - 条件数组或单个条件
 * @returns {{ valid: boolean, reason: string, failedCondition?: string }}
 */
function validateNot(ctx, conditions) {
    const conditionArray = Array.isArray(conditions) ? conditions : [conditions];

    for (const condition of conditionArray) {
        const result = executeValidator(ctx, condition);
        // NOT 逻辑：如果验证通过（valid: true），则 NOT 失败
        if (result.valid) {
            return {
                valid: false,
                reason: `不满足使用条件：${getNotReason(condition)}`,
                failedCondition: `not_${condition}`
            };
        }
    }

    return { valid: true, reason: '' };
}

/**
 * 执行单个验证器
 * @param {Context} ctx - 上下文对象
 * @param {string} condition - 条件名称
 * @returns {{ valid: boolean, reason: string }}
 */
function executeValidator(ctx, condition) {
    const validator = VALIDATORS[condition];

    if (!validator) {
        return {
            valid: false,
            reason: `未知的 usage 条件: ${condition}`
        };
    }

    try {
        return validator(ctx);
    } catch (error) {
        return {
            valid: false,
            reason: `验证器执行失败: ${error.message}`
        };
    }
}

/**
 * 获取 NOT 条件的错误提示
 * @param {string} condition - 条件名称
 * @returns {string}
 */
function getNotReason(condition) {
    const notReasons = {
        inGuild: '此功能不能在服务器中使用',
        inDM: '此功能不能在私信中使用',
        inThread: '此功能不能在线程中使用',
        inForumPost: '此功能不能在论坛帖子中使用',
        isThreadOwner: '线程创建者不能使用此功能',
        isServerOwner: '服务器所有者不能使用此功能',
        isMessageAuthor: '不能对自己的消息执行此操作',
        isTargetSelf: '不能对自己执行此操作',
        targetIsBot: '不能对机器人执行此操作',
        targetNotBot: '只能对机器人执行此操作'
    };

    return notReasons[condition] || `不满足条件: ${condition}`;
}

