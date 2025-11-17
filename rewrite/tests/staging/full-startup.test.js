/**
 * Staging环境完整启动测试
 *
 * 用途：测试Application完整启动流程，包括真实Discord连接
 *
 * 运行条件：
 * - 需要设置 TEST_BOT_TOKEN 环境变量
 * - 需要一个测试用Discord Bot
 *
 * 运行方法：
 * TEST_BOT_TOKEN=your_token pnpm test:staging
 *
 * 或在CI/CD中：
 * - 在GitHub Actions secrets中添加TEST_BOT_TOKEN
 * - 在staging环境运行此测试
 */

import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../../core/Application.js';

// 检查是否有测试token和clientId
const hasTestToken = !!process.env.TEST_BOT_TOKEN;
const hasTestClientId = !!process.env.TEST_BOT_CLIENT_ID;

// 临时设置DISCORD_CLIENT_ID用于测试
if (hasTestClientId && !process.env.DISCORD_CLIENT_ID) {
    process.env.DISCORD_CLIENT_ID = process.env.TEST_BOT_CLIENT_ID;
}

describe.skipIf(!hasTestToken || !hasTestClientId)('Full Startup Integration (Staging)', () => {
    let app;

    const testConfig = {
        token: process.env.TEST_BOT_TOKEN,
        bot: {
            clientId: process.env.TEST_BOT_CLIENT_ID,
            logLevel: 'info',
            gracefulShutdownTimeout: 10000
        },
        modulesPath: join(process.cwd(), 'rewrite/modules'),
        guildsDir: join(process.cwd(), 'rewrite/config/guilds')
    };

    afterEach(async () => {
        if (app) {
            try {
                await app.stop();
            } catch (error) {
                console.error('停止Application失败:', error);
            }
        }
    });

    it('应该完整启动Application并连接Discord', async () => {
        console.log('\n🚀 开始完整启动测试...');

        app = new Application(testConfig);

        // 初始化
        console.log('   初始化中...');
        await app.initialize();
        expect(app.logger).toBeDefined();
        expect(app.registry).toBeDefined();
        expect(app.client).toBeDefined();

        // 启动（包括Discord login）
        console.log('   登录Discord...');
        await app.start();

        // 等待ready事件
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 验证客户端已就绪
        expect(app.client.isReady()).toBe(true);
        console.log('   ✅ Discord连接成功');

        // 验证模块已加载
        expect(app.registry.commands.size).toBeGreaterThan(0);
        expect(app.registry.commands.has('ping')).toBe(true);
        console.log(`   ✅ 已加载 ${app.registry.commands.size} 个命令`);

    }, 30000);  // 30秒超时

    it('应该正确处理优雅关闭', async () => {
        app = new Application(testConfig);
        await app.initialize();
        await app.start();

        // 等待就绪
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 优雅关闭
        await expect(app.stop()).resolves.not.toThrow();

    }, 30000);

    it('应该在启动后能够访问所有服务', async () => {
        app = new Application(testConfig);
        await app.initialize();
        await app.start();

        await new Promise(resolve => setTimeout(resolve, 2000));

        // 验证所有核心服务可访问
        expect(app.container.has('logger')).toBe(true);
        expect(app.container.has('registry')).toBe(true);
        expect(app.container.has('config')).toBe(true);
        expect(app.container.has('configManager')).toBe(true);
        expect(app.container.has('cooldownManager')).toBe(true);

    }, 30000);
});

// 提示信息
if (!hasTestToken || !hasTestClientId) {
    console.log('\n💡 Staging测试被跳过');
    if (!hasTestToken) {
    console.log('   原因: 未设置 TEST_BOT_TOKEN 环境变量');
    }
    if (!hasTestClientId) {
        console.log('   原因: 未设置 TEST_BOT_CLIENT_ID 环境变量');
    }
    console.log('   运行方法: TEST_BOT_TOKEN=your_token TEST_BOT_CLIENT_ID=your_client_id pnpm test:staging\n');
}

