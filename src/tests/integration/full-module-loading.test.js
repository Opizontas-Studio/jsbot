/**
 * 真实模块加载集成测试
 * 测试Registry能否正确加载src/modules目录下的真实模块
 */
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Container } from '../../core/Container.js';
import { Logger } from '../../core/Logger.js';
import { Registry } from '../../core/Registry.js';

describe('Full Module Loading Integration', () => {
    let registry;
    let container;
    let logger;

    beforeEach(() => {
        container = new Container();
        logger = new Logger({
            level: 'silent', // 测试时静默
            prettyPrint: false
        });

        container.registerInstance('logger', logger);
        container.registerInstance('config', {});

        registry = new Registry(container, logger);
    });

    describe('加载真实example模块', () => {
        it('应该能加载example/commands/ping.js', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');

            await registry.loadModules(modulesPath);

            // 验证ping命令被加载
            expect(registry.commands.has('ping')).toBe(true);

            const pingCommand = registry.commands.get('ping');
            expect(pingCommand).toBeDefined();
            expect(pingCommand.id).toBe('example.ping');
            expect(pingCommand.type).toBe('command');
            expect(pingCommand.name).toBe('ping');
            expect(typeof pingCommand.execute).toBe('function');
        });

        it('应该记录加载的模块到diagnostics', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');

            await registry.loadModules(modulesPath);

            // 验证diagnostics记录
            expect(registry.diagnostics.loaded.length).toBeGreaterThan(0);

            // 查找ping命令的加载记录
            const pingRecord = registry.diagnostics.loaded.find(record => record.id === 'example.ping');
            expect(pingRecord).toBeDefined();
            expect(pingRecord.type).toBe('command');
            expect(pingRecord.name).toBe('ping');
        });

        it('应该正确编译命令的builder', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');

            await registry.loadModules(modulesPath);

            const pingCommand = registry.commands.get('ping');

            // 验证builder函数存在
            expect(typeof pingCommand.builder).toBe('function');

            // 验证execute函数存在
            expect(typeof pingCommand.execute).toBe('function');
        });

        it('应该处理模块加载错误不崩溃', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');

            // 即使有些模块加载失败，也不应该抛出错误
            await expect(registry.loadModules(modulesPath)).resolves.not.toThrow();
        });
    });

    describe('验证模块配置完整性', () => {
        it('加载的命令应该具有所有必需字段', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');
            await registry.loadModules(modulesPath);

            // 检查所有加载的命令
            for (const [name, config] of registry.commands) {
                expect(config.id).toBeDefined();
                expect(config.type).toBe('command');
                expect(config.name).toBe(name);
                expect(config.execute).toBeDefined();
                expect(typeof config.execute).toBe('function');

                // Slash命令应该有builder
                if (config.commandKind === 'slash') {
                    expect(config.builder).toBeDefined();
                    expect(typeof config.builder).toBe('function');
                }
            }
        });
    });

    describe('扫描性能', () => {
        it('应该在合理时间内完成模块加载', async () => {
            const modulesPath = join(process.cwd(), 'src/modules');

            const startTime = Date.now();
            await registry.loadModules(modulesPath);
            const duration = Date.now() - startTime;

            // 加载应该在1秒内完成
            expect(duration).toBeLessThan(1000);
        });
    });
});
