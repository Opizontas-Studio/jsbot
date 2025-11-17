import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from '../../core/Registry.js';

describe('Registry', () => {
    let registry;
    let mockContainer;
    let mockLogger;

    beforeEach(() => {
        mockContainer = {
            get: vi.fn((name) => {
                if (name === 'logger') return mockLogger;
                return {};
            }),
            resolve: vi.fn((deps) => {
                const resolved = {};
                for (const dep of deps) {
                    resolved[dep] = {};
                }
                return resolved;
            })
        };

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };

        registry = new Registry(mockContainer, mockLogger);
    });

    describe('loadModules', () => {
        // 注意：loadModules涉及真实的文件系统和动态import
        // 在Jest的ESM环境中测试动态创建的文件有兼容性问题
        // 这些场景已在Application集成测试中覆盖
        // 这里仅测试不依赖文件系统的边界情况

        it('应该处理不存在的目录不崩溃', async () => {
            const nonExistentDir = '/tmp/nonexistent-test-dir-' + Date.now();

            // 不应该抛出错误，只是无法加载模块
            await expect(
                registry.loadModules(nonExistentDir)
            ).resolves.not.toThrow();
        });
    });

    describe('_validateConfig', () => {
        it('应该验证命令配置', () => {
            const validCommand = {
                id: 'test.cmd',
                type: 'command',
                name: 'test',
                commandKind: 'slash',
                builder: () => {},
                execute: async () => {}
            };

            const result = registry._validateConfig(validCommand);
            expect(result.valid).toBe(true);
        });

        it('应该拒绝缺少name的命令', () => {
            const invalidCommand = {
                id: 'test.cmd',
                type: 'command',
                execute: async () => {}
            };

            const result = registry._validateConfig(invalidCommand);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('name');
        });

        it('应该验证按钮配置', () => {
            const validButton = {
                id: 'test.btn',
                type: 'button',
                pattern: 'btn_{id}',
                handle: async () => {}
            };

            const result = registry._validateConfig(validButton);
            expect(result.valid).toBe(true);
        });

        it('应该验证事件配置', () => {
            const validEvent = {
                id: 'test.event',
                type: 'event',
                event: 'guildMemberAdd',
                handle: async () => {}
            };

            const result = registry._validateConfig(validEvent);
            expect(result.valid).toBe(true);
        });

        it('应该拒绝未知类型', () => {
            const invalidConfig = {
                id: 'test.unknown',
                type: 'unknownType'
            };

            const result = registry._validateConfig(invalidConfig);
            expect(result.valid).toBe(false);
        });
    });

    describe('_compilePattern', () => {
        it('应该编译简单pattern', () => {
            const route = registry._compilePattern('button_{id}');

            expect(route.regex.test('button_123')).toBe(true);
            expect(route.regex.test('button_abc')).toBe(true);
            expect(route.regex.test('other_123')).toBe(false);
        });

        it('应该提取参数', () => {
            const route = registry._compilePattern('button_{action}_{id}');
            const params = route.extractor('button_approve_123');

            expect(params.action).toBe('approve');
            expect(params.id).toBe('123');
        });

        it('应该支持int类型', () => {
            const route = registry._compilePattern('item_{id:int}');
            const params = route.extractor('item_456');

            expect(params.id).toBe(456);
            expect(typeof params.id).toBe('number');
        });

        it('应该支持snowflake类型', () => {
            const route = registry._compilePattern('user_{id:snowflake}');
            const params = route.extractor('user_123456789012345678');

            expect(params.id).toBe('123456789012345678');
        });

        it('应该支持enum类型', () => {
            const route = registry._compilePattern('action_{type:enum(approve,reject)}');

            expect(route.regex.test('action_approve')).toBe(true);
            expect(route.regex.test('action_reject')).toBe(true);
            expect(route.regex.test('action_other')).toBe(false);
        });

        it('应该支持可选参数', () => {
            const route = registry._compilePattern('item_{id}_{extra?}');

            expect(route.regex.test('item_123_extra')).toBe(true);
            expect(route.regex.test('item_123_')).toBe(true);

            const params1 = route.extractor('item_123_extra');
            expect(params1.extra).toBe('extra');

            const params2 = route.extractor('item_123_');
            // 可选参数匹配空值时应为null
            expect(params2.extra === '' || params2.extra === null).toBe(true);
        });

        it('应该支持多个参数', () => {
            const route = registry._compilePattern('complex_{a}_{b:int}_{c:enum(x,y)}');
            const params = route.extractor('complex_test_42_x');

            expect(params.a).toBe('test');
            expect(params.b).toBe(42);
            expect(params.c).toBe('x');
        });
    });

    describe('findCommand', () => {
        it('应该查找已注册的命令', () => {
            const config = {
                id: 'test.cmd',
                type: 'command',
                name: 'test',
                execute: async () => {}
            };

            registry.commands.set('test', config);

            const found = registry.findCommand('test');
            expect(found).toBe(config);
        });

        it('应该返回null当命令不存在', () => {
            const found = registry.findCommand('nonexistent');
            expect(found).toBeNull();
        });
    });

    describe('findButton', () => {
        it('应该查找匹配的按钮配置', () => {
            const config = {
                id: 'test.btn',
                type: 'button',
                pattern: 'btn_{id}',
                handle: async () => {}
            };

            registry._registerInteractionConfig(registry.buttons, config, 'button');

            const result = registry.findButton('btn_123');
            expect(result).not.toBeNull();
            expect(result.config).toBe(config);
            expect(result.params.id).toBe('123');
        });

        it('应该返回null当无匹配', () => {
            const result = registry.findButton('unknown_btn');
            expect(result).toBeNull();
        });
    });

    describe('getEventHandlers', () => {
        it('应该返回指定事件的处理器', () => {
            const handler1 = {
                id: 'test.handler1',
                type: 'event',
                event: 'guildMemberAdd',
                priority: 10,
                handle: async () => {}
            };

            const handler2 = {
                id: 'test.handler2',
                type: 'event',
                event: 'guildMemberAdd',
                priority: 5,
                handle: async () => {}
            };

            registry.events.set('guildMemberAdd', [handler1, handler2]);

            const handlers = registry.getEventHandlers('guildMemberAdd');
            expect(handlers).toHaveLength(2);
            expect(handlers[0]).toBe(handler1);
            expect(handlers[1]).toBe(handler2);
        });

        it('应该返回空数组当事件无处理器', () => {
            const handlers = registry.getEventHandlers('unknownEvent');
            expect(handlers).toEqual([]);
        });

        it('应该按优先级排序处理器', () => {
            const config1 = {
                id: 'test.h1',
                type: 'event',
                event: 'testEvent',
                priority: 5,
                handle: async () => {}
            };

            const config2 = {
                id: 'test.h2',
                type: 'event',
                event: 'testEvent',
                priority: 10,
                handle: async () => {}
            };

            const config3 = {
                id: 'test.h3',
                type: 'event',
                event: 'testEvent',
                priority: 1,
                handle: async () => {}
            };

            // 注册时应该自动排序
            registry._registerConfig(config1, 'test.js');
            registry._registerConfig(config2, 'test.js');
            registry._registerConfig(config3, 'test.js');

            const handlers = registry.getEventHandlers('testEvent');
            expect(handlers[0].priority).toBe(10);
            expect(handlers[1].priority).toBe(5);
            expect(handlers[2].priority).toBe(1);
        });
    });

    describe('getTasks', () => {
        it('应该返回所有任务配置', () => {
            const task1 = { id: 'task1' };
            const task2 = { id: 'task2' };

            registry.tasks.set('task1', task1);
            registry.tasks.set('task2', task2);

            const tasks = registry.getTasks();
            expect(tasks.size).toBe(2);
            expect(tasks.get('task1')).toBe(task1);
            expect(tasks.get('task2')).toBe(task2);
        });
    });

    describe('getCommandsForDeploy', () => {
        it('应该返回所有命令配置数组', () => {
            const cmd1 = { id: 'cmd1', name: 'cmd1' };
            const cmd2 = { id: 'cmd2', name: 'cmd2' };

            registry.commands.set('cmd1', cmd1);
            registry.commands.set('cmd2', cmd2);

            const commands = registry.getCommandsForDeploy();
            expect(commands).toHaveLength(2);
            expect(commands).toContain(cmd1);
            expect(commands).toContain(cmd2);
        });
    });

    describe('getDiagnostics', () => {
        it('应该返回诊断信息', () => {
            registry.diagnostics.loaded.push({ type: 'command', id: 'test' });
            registry.diagnostics.failed.push({ file: 'test.js', reason: 'error' });

            const diagnostics = registry.getDiagnostics();
            expect(diagnostics.loaded).toHaveLength(1);
            expect(diagnostics.failed).toHaveLength(1);
        });
    });
});

