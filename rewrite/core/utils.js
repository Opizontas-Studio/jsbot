/**
 * 核心工具函数
 * 提供应用启动、服务注册、中间件创建等工具函数
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../config/loader.js';
import { CooldownManager } from '../infrastructure/CooldownManager.js';
import { MiddlewareChain } from './MiddlewareChain.js';
import { cooldownMiddleware } from './middleware/cooldown.js';
import { deferMiddleware } from './middleware/defer.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.js';
import { permissionsMiddleware } from './middleware/permissions.js';
import { usageMiddleware } from './middleware/usage.js';

// ==================== 启动相关工具 ====================

/**
 * 设置优雅关闭处理器
 * @param {Application} app - 应用实例
 * @param {Object} config - 配置对象
 */
export function setupGracefulShutdown(app, config) {
    const gracefulShutdown = async (signal) => {
        console.log(`\n收到 ${signal} 信号，正在优雅关闭...`);

        try {
            // 设置超时（防止卡住）
            const timeout = setTimeout(() => {
                console.error('优雅关闭超时，强制退出');
                process.exit(1);
            }, config.bot?.gracefulShutdownTimeout || 30000);

            // 停止应用
            await app.stop();

            clearTimeout(timeout);
            process.exit(0);
        } catch (error) {
            console.error('❌ 优雅关闭失败:', error);
            process.exit(1);
        }
    };

    // 注册信号处理
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // 未捕获异常处理
    process.on('uncaughtException', (error) => {
        console.error('❌ 未捕获的异常:', error);
        gracefulShutdown('uncaughtException');
    });

    // 未处理的Promise拒绝
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ 未处理的Promise拒绝:', reason);
        console.error('Promise:', promise);
    });
}

/**
 * 检测并映射测试模式环境变量
 * @returns {boolean} 是否为测试模式
 */
export function detectTestMode() {
    const isTestMode = process.argv.includes('--test');

    if (isTestMode) {
        if (!process.env.TEST_BOT_TOKEN || !process.env.TEST_BOT_CLIENT_ID) {
            console.error('❌ 测试模式启动失败: 未找到 TEST_BOT_TOKEN 或 TEST_BOT_CLIENT_ID');
            process.exit(1);
        }
        console.log('🧪 使用测试Token启动...\n');
        process.env.DISCORD_TOKEN = process.env.TEST_BOT_TOKEN;
        process.env.DISCORD_CLIENT_ID = process.env.TEST_BOT_CLIENT_ID;
    }

    return isTestMode;
}

/**
 * 获取默认路径配置
 * @returns {Object} 路径配置对象
 */
export function getDefaultPaths() {
    const cwd = process.cwd();
    return {
        configPath: `${cwd}/rewrite/config/config.json`,
        guildsDir: `${cwd}/rewrite/config/guilds`,
        envPath: `${cwd}/.env`
    };
}

// ==================== 服务注册工具 ====================

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

    logger.debug('[Utils] 核心服务已注册');
}

// ==================== 中间件创建工具 ====================

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

    logger.debug('[Utils] 中间件链已创建');

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
    logger.debug('[Utils] 自定义中间件链已创建');
    return middlewareChain;
}

// ==================== 版本信息工具 ====================

/**
 * 获取应用程序版本信息
 * @param {Logger} [logger] - 可选的日志器，用于输出错误信息
 * @returns {Object|null} 包含版本号、提交哈希和提交日期的对象，如果获取失败则返回null
 */
export function getVersionInfo(logger = null) {
    try {
        const packagePath = join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        const version = 'v' + packageJson.version;
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitDate = execSync('git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();

        return {
            version,
            commitHash,
            commitDate,
        };
    } catch (error) {
        const errorMsg = '[Utils] 获取版本信息失败';
        if (logger) {
            logger.error({ msg: errorMsg, error: error.message });
        } else {
            console.error(errorMsg + ':', error.message);
        }
        return null;
    }
}
