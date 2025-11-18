/**
 * 中间件工厂
 * 负责创建和配置中间件链
 */

import { MiddlewareChain } from '../middleware/MiddlewareChain.js';
import { cooldownMiddleware } from '../middleware/cooldown.js';
import { deferMiddleware } from '../middleware/defer.js';
import { executionWrapperMiddleware } from '../middleware/executionWrapper.js';
import { permissionsMiddleware } from '../middleware/permissions.js';
import { queueMiddleware } from '../middleware/queue.js';
import { usageMiddleware } from '../middleware/usage.js';

/**
 * 创建默认中间件链
 * @param {Container} container - DI容器
 * @returns {MiddlewareChain}
 */
export function createMiddlewareChain(container) {
    const middlewareChain = new MiddlewareChain();

    // 按执行顺序添加中间件
    // executionWrapper(tracking+error) → defer → usage → permissions → cooldown → queue → handler
    middlewareChain.use(executionWrapperMiddleware(container.get('activeOperationTracker')));
    middlewareChain.use(deferMiddleware);
    middlewareChain.use(usageMiddleware);
    middlewareChain.use(permissionsMiddleware);
    middlewareChain.use(cooldownMiddleware(container.get('cooldownManager')));
    middlewareChain.use(queueMiddleware(container.get('queueManager')));

    const logger = container.get('logger');
    logger?.debug('[Bootstrap] 中间件链已创建');

    return middlewareChain;
}

/**
 * 创建自定义中间件链
 * @param {Array<Function>} middlewares - 中间件函数数组
 * @param {Container} container - DI容器
 * @returns {MiddlewareChain}
 */
export function createCustomMiddlewareChain(middlewares, container) {
    const middlewareChain = new MiddlewareChain(middlewares);
    const logger = container?.get('logger');
    logger?.debug('[Bootstrap] 自定义中间件链已创建');
    return middlewareChain;
}
