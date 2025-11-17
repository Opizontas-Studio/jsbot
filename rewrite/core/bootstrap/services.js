/**
 * 核心服务注册器
 * 负责将核心服务注册到DI容器
 */

import { ConfigManager } from '../../config/loader.js';
import { ActiveOperationTracker } from '../../infrastructure/ActiveOperationTracker.js';
import { CooldownManager } from '../../infrastructure/CooldownManager.js';
import { LockManager } from '../../infrastructure/LockManager.js';
import { QueueManager } from '../../infrastructure/QueueManager.js';
import { SchedulerManager } from '../../infrastructure/SchedulerManager.js';
import { ApiClient } from '../../infrastructure/api/ApiClient.js';
import { BatchProcessor } from '../../infrastructure/api/BatchProcessor.js';
import { RateLimiter } from '../../infrastructure/api/RateLimiter.js';
import { DatabaseManager } from '../../infrastructure/database/DatabaseManager.js';
import { CommandDeployer } from '../CommandDeployer.js';
import { ModuleReloader } from '../ModuleReloader.js';

/**
 * 注册核心服务到DI容器
 * @param {Container} container - DI容器
 * @param {Object} config - 应用配置
 * @param {Logger} logger - 日志器
 */
export function bootstrapCoreServices(container, config, logger) {
    // 注册核心服务
    container.registerInstance('config', config);
    container.registerInstance('logger', logger);
    container.registerInstance('configManager', new ConfigManager(config, logger));
    container.registerInstance('cooldownManager', new CooldownManager());

    // 注册基础设施层服务
    container.register('activeOperationTracker', (c) => {
        return new ActiveOperationTracker({ logger: c.get('logger') });
    });
    container.register('lockManager', (c) => {
        const lockManager = new LockManager({
            timeout: config.lock?.timeout,
            maxPending: config.lock?.maxPending
        });
        lockManager.setLogger(c.get('logger'));
        return lockManager;
    });
    container.register('queueManager', (c) => {
        const queueManager = new QueueManager({
            concurrency: config.queue?.concurrency,
            timeout: config.queue?.timeout,
            priorities: config.queue?.priorities
        });
        queueManager.setDependencies(
            c.get('logger'),
            c.get('lockManager')
        );
        return queueManager;
    });
    container.register('schedulerManager', (c) => {
        const schedulerManager = new SchedulerManager();
        schedulerManager.setLogger(c.get('logger'));
        return schedulerManager;
    });
    container.register('databaseManager', (c) => {
        const dbManager = new DatabaseManager(config.database);
        dbManager.setLogger(c.get('logger'));
        return dbManager;
    });

    // API包装层服务
    container.register('rateLimiter', (c) => {
        const rateLimiter = new RateLimiter({
            global: config.api?.rateLimit?.global,
            routes: config.api?.rateLimit?.routes
        });
        rateLimiter.setLogger(c.get('logger'));
        return rateLimiter;
    });
    container.register('apiClient', (c) => {
        return new ApiClient({
            rateLimiter: c.get('rateLimiter'),
            callTracker: null, // 初始为null，稍后由MonitoringManager注入
            logger: c.get('logger')
        });
    });
    container.register('batchProcessor', (c) => {
        return new BatchProcessor({
            apiClient: c.get('apiClient'),
            queueManager: c.get('queueManager'),
            logger: c.get('logger')
        });
    });

    // 注册后置核心服务
    container.register('commandDeployer', (c) => new CommandDeployer(c, c.get('logger'))); // 延迟初始化，因为依赖client和registry
    container.register('moduleReloader', (c) => new ModuleReloader({ logger: c.get('logger'), registry: c.get('registry'), container: c })); // 可重载所有模块
    logger.debug('[Bootstrap] 核心服务已注册');
}
