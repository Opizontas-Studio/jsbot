/**
 * 核心服务注册器
 * 负责将核心服务注册到DI容器
 */

import { ConfigManager } from '../../config/loader.js';
import { CooldownManager } from '../../infrastructure/CooldownManager.js';
import { CommandDeployer } from '../CommandDeployer.js';
import { ModuleReloader } from '../ModuleReloader.js';

/**
 * 注册核心服务到DI容器
 * @param {Container} container - DI容器
 * @param {Object} config - 应用配置
 * @param {Logger} logger - 日志器
 */
export function bootstrapCoreServices(container, config, logger) {
    // 注册配置
    container.registerInstance('config', config);

    // 注册Logger
    container.registerInstance('logger', logger);

    // 注册ConfigManager（传入logger以支持结构化日志）
    container.registerInstance('configManager', new ConfigManager(config, logger));

    // 注册CooldownManager
    container.registerInstance('cooldownManager', new CooldownManager());

    // 注册CommandDeployer（延迟初始化，因为依赖client和registry）
    container.register('commandDeployer', (c) => new CommandDeployer(c, c.get('logger')));

    // 注册ModuleReloader（核心服务，可重载所有模块）
    container.register('moduleReloader', (c) => new ModuleReloader({
        logger: c.get('logger'),
        registry: c.get('registry'),
        container: c
    }));

    logger.debug('[Bootstrap] 核心服务已注册');
}

