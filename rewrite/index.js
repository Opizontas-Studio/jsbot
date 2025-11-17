/**
 * Gatekeeper Bot - Rewrite 版本主入口
 * 负责加载配置、初始化应用、处理优雅关闭
 */

import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config/loader.js';
import { Application } from './core/Application.js';
import { detectTestMode, getDefaultPaths, setupGracefulShutdown } from './core/utils.js';

// 检查并处理测试模式
const isTestMode = process.argv.includes('--test');
console.log(`🚀 Gatekeeper Bot (Rewrite) 启动中...${isTestMode ? ' [测试模式]' : ''}\n`);

// 获取默认路径
const paths = getDefaultPaths();

// 预加载环境变量
loadDotenv({ path: paths.envPath });

// 处理测试模式
detectTestMode();

// 启动应用
(async () => {
    try {
        // 加载配置
        const config = loadConfig({
            configPath: paths.configPath,
            guildsDir: paths.guildsDir,
            envPath: paths.envPath
        });

        // 创建应用实例
        const app = new Application(config);

        // 设置优雅关闭
        setupGracefulShutdown(app, config);

        // 初始化应用
        await app.initialize();

        // 启动应用
        await app.start();
    } catch (error) {
        console.error('❌ 启动失败:', error);
        console.error(error.stack);
        process.exit(1);
    }
})();
