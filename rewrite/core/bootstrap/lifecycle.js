/**
 * 应用生命周期管理
 * 提供优雅关闭、测试模式检测、默认路径配置等功能
 */

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

