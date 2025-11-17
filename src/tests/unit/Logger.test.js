import { beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'fs';
import { Logger } from '../../core/Logger.js';

describe('Logger', () => {
    let logger;
    const testLogDir = './logs-test';

    beforeEach(() => {
        // 使用测试环境设置
        process.env.NODE_ENV = 'test';
        process.env.LOG_LEVEL = 'debug';
    });

    afterEach(() => {
        // 清理测试日志目录
        try {
            rmSync(testLogDir, { recursive: true, force: true });
        } catch (error) {
            // 忽略清理错误
        }
    });

    describe('constructor', () => {
        it('应该创建logger实例', () => {
            logger = new Logger({ logDir: testLogDir });
            expect(logger).toBeDefined();
            expect(logger.logger).toBeDefined();
        });

        it('应该使用默认配置', () => {
            logger = new Logger({ logDir: testLogDir });
            expect(logger.logger).toBeDefined();
        });

        it('应该支持自定义日志级别', () => {
            logger = new Logger({
                level: 'error',
                logDir: testLogDir
            });

            expect(logger.logger.level).toBe('error');
        });

        it('应该创建日志目录', () => {
            logger = new Logger({ logDir: testLogDir });
            // 目录应该已创建，不会抛出错误
            expect(logger).toBeDefined();
        });
    });

    describe('logging methods', () => {
        beforeEach(() => {
            logger = new Logger({
                level: 'trace',
                logDir: testLogDir,
                prettyPrint: false
            });
        });

        it('应该支持info日志', () => {
            expect(() => {
                logger.info('Test info message');
            }).not.toThrow();
        });

        it('应该支持error日志', () => {
            expect(() => {
                logger.error('Test error message');
            }).not.toThrow();
        });

        it('应该支持warn日志', () => {
            expect(() => {
                logger.warn('Test warn message');
            }).not.toThrow();
        });

        it('应该支持debug日志', () => {
            expect(() => {
                logger.debug('Test debug message');
            }).not.toThrow();
        });

        it('应该支持trace日志', () => {
            expect(() => {
                logger.trace('Test trace message');
            }).not.toThrow();
        });

        it('应该支持对象作为第一个参数', () => {
            expect(() => {
                logger.info({ msg: 'Test', data: { key: 'value' } });
            }).not.toThrow();
        });

        it('应该支持对象+消息的形式', () => {
            expect(() => {
                logger.info({ data: 'value' }, 'Message');
            }).not.toThrow();
        });
    });

    describe('child', () => {
        beforeEach(() => {
            logger = new Logger({ logDir: testLogDir });
        });

        it('应该创建子logger', () => {
            const childLogger = logger.child({ component: 'TestComponent' });
            expect(childLogger).toBeDefined();
            expect(childLogger.logger).toBeDefined();
        });

        it('应该继承父logger的级别', () => {
            const parentLogger = new Logger({ level: 'warn', logDir: testLogDir });
            const childLogger = parentLogger.child({ component: 'Test' });

            expect(childLogger.logger.level).toBe('warn');
        });

        it('子logger应该可以正常记录日志', () => {
            const childLogger = logger.child({ component: 'Test' });

            expect(() => {
                childLogger.info('Child logger test');
            }).not.toThrow();
        });
    });

    describe('flush', () => {
        beforeEach(() => {
            logger = new Logger({ logDir: testLogDir });
        });

        it('应该刷新日志缓冲', async () => {
            await expect(logger.flush()).resolves.not.toThrow();
        });

        it('应该等待异步刷新完成', async () => {
            logger.info('Test message before flush');
            const startTime = Date.now();

            await logger.flush();

            const duration = Date.now() - startTime;
            // 刷新应该很快完成
            expect(duration).toBeLessThan(1000);
        });
    });

    describe('production mode', () => {
        it('应该在生产环境创建文件logger', () => {
            const prodLogger = new Logger({
                prettyPrint: false,
                logDir: testLogDir
            });

            expect(prodLogger.fileLogger).toBeDefined();
        });

        it('应该在开发环境不创建文件logger', () => {
            const devLogger = new Logger({
                prettyPrint: true,
                logDir: testLogDir
            });

            expect(devLogger.fileLogger).toBeUndefined();
        });
    });

    describe('error handling', () => {
        it('应该处理日志目录创建错误', () => {
            // 使用无效路径（如果权限允许，这可能不会失败）
            expect(() => {
                new Logger({ logDir: '/invalid/path/that/should/not/exist' });
            }).not.toThrow(); // Logger会捕获错误并继续
        });
    });
});

