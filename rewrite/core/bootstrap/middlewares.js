/**
 * 中间件工厂
 * 负责创建和配置中间件链
 */

import { MiddlewareChain } from '../middleware/MiddlewareChain.js';
import { cooldownMiddleware } from '../middleware/cooldown.js';
import { deferMiddleware } from '../middleware/defer.js';
import { errorHandlerMiddleware } from '../middleware/errorHandler.js';
import { permissionsMiddleware } from '../middleware/permissions.js';
import { usageMiddleware } from '../middleware/usage.js';

/**
 * 创建默认中间件链
 * @param {Container} container - DI容器
 * @param {Logger} logger - 日志器
 * @returns {MiddlewareChain}
 */
export function createMiddlewareChain(container, logger) {
    const middlewareChain = new MiddlewareChain();

    // 按执行顺序添加中间件
    // errorHandler → defer → usage → permissions → cooldown → handler
    middlewareChain.use(errorHandlerMiddleware(logger));
    middlewareChain.use(deferMiddleware(logger));
    middlewareChain.use(usageMiddleware(logger));
    middlewareChain.use(permissionsMiddleware(logger));
    middlewareChain.use(cooldownMiddleware(
        container.get('cooldownManager'),
        logger
    ));

    logger.debug('[Bootstrap] 中间件链已创建');

    return middlewareChain;
}

/**
 * 创建自定义中间件链
 * @param {Array<Function>} middlewares - 中间件函数数组
 * @param {Logger} logger - 日志器
 * @returns {MiddlewareChain}
 */
export function createCustomMiddlewareChain(middlewares, logger) {
    const middlewareChain = new MiddlewareChain(middlewares);
    logger.debug('[Bootstrap] 自定义中间件链已创建');
    return middlewareChain;
}

