import { beforeEach, describe, expect, it } from 'vitest';
import { Container } from '../../core/Container.js';

describe('Container', () => {
    let container;

    beforeEach(() => {
        container = new Container();
    });

    describe('register', () => {
        it('应该成功注册工厂函数', () => {
            const factory = () => ({ value: 'test' });
            container.register('testService', factory);
            expect(container.has('testService')).toBe(true);
        });

        it('应该拒绝非函数工厂', () => {
            expect(() => {
                container.register('testService', 'not a function');
            }).toThrow('Factory for testService must be a function');
        });
    });

    describe('registerInstance', () => {
        it('应该成功注册实例', () => {
            const instance = { value: 'test' };
            container.registerInstance('testService', instance);
            expect(container.get('testService')).toBe(instance);
        });
    });

    describe('get', () => {
        it('应该返回已注册的实例', () => {
            const instance = { value: 'test' };
            container.registerInstance('testService', instance);
            expect(container.get('testService')).toBe(instance);
        });

        it('应该懒加载工厂实例', () => {
            let factoryCalled = false;
            container.register('testService', () => {
                factoryCalled = true;
                return { value: 'test' };
            });

            expect(factoryCalled).toBe(false);
            const instance = container.get('testService');
            expect(factoryCalled).toBe(true);
            expect(instance.value).toBe('test');
        });

        it('应该缓存工厂实例（单例）', () => {
            let callCount = 0;
            container.register('testService', () => {
                callCount++;
                return { value: callCount };
            });

            const instance1 = container.get('testService');
            const instance2 = container.get('testService');

            expect(callCount).toBe(1);
            expect(instance1).toBe(instance2);
        });

        it('应该抛出错误当服务不存在', () => {
            expect(() => {
                container.get('nonExistent');
            }).toThrow('Service nonExistent not found in container');
        });

        it('应该检测循环依赖', () => {
            container.register('serviceA', c => c.get('serviceB'));
            container.register('serviceB', c => c.get('serviceA'));

            expect(() => {
                container.get('serviceA');
            }).toThrow('Circular dependency detected');
        });

        it('应该支持依赖注入', () => {
            container.registerInstance('config', { value: 'test' });
            container.register('serviceA', c => ({
                config: c.get('config')
            }));

            const service = container.get('serviceA');
            expect(service.config.value).toBe('test');
        });
    });

    describe('has', () => {
        it('应该返回true当服务存在', () => {
            container.registerInstance('testService', {});
            expect(container.has('testService')).toBe(true);
        });

        it('应该返回true当工厂存在', () => {
            container.register('testService', () => ({}));
            expect(container.has('testService')).toBe(true);
        });

        it('应该返回false当服务不存在', () => {
            expect(container.has('nonExistent')).toBe(false);
        });
    });

    describe('resolve', () => {
        it('应该批量解析依赖', () => {
            container.registerInstance('serviceA', { name: 'A' });
            container.registerInstance('serviceB', { name: 'B' });
            container.registerInstance('serviceC', { name: 'C' });

            const deps = container.resolve(['serviceA', 'serviceB', 'serviceC']);

            expect(deps.serviceA.name).toBe('A');
            expect(deps.serviceB.name).toBe('B');
            expect(deps.serviceC.name).toBe('C');
        });

        it('应该返回空对象当依赖列表为空', () => {
            const deps = container.resolve([]);
            expect(deps).toEqual({});
        });

        it('应该抛出错误当依赖不存在', () => {
            expect(() => {
                container.resolve(['nonExistent']);
            }).toThrow('Service nonExistent not found in container');
        });
    });

    describe('validateAll', () => {
        it('应该返回空数组当所有服务可解析', () => {
            container.register('serviceA', () => ({ name: 'A' }));
            container.register('serviceB', c => ({ serviceA: c.get('serviceA') }));

            const errors = container.validateAll();
            expect(errors).toEqual([]);
        });

        it('应该返回错误列表当服务不可解析', () => {
            container.register('serviceA', c => c.get('nonExistent'));
            container.register('serviceB', () => ({ name: 'B' }));

            const errors = container.validateAll();
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].service).toBe('serviceA');
            expect(errors[0].error).toContain('nonExistent');
        });

        it('应该检测循环依赖', () => {
            container.register('serviceA', c => c.get('serviceB'));
            container.register('serviceB', c => c.get('serviceA'));

            const errors = container.validateAll();
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].error).toContain('Circular dependency');
        });
    });

    describe('clear', () => {
        it('应该清除所有服务', () => {
            container.registerInstance('serviceA', {});
            container.register('serviceB', () => ({}));

            expect(container.has('serviceA')).toBe(true);
            expect(container.has('serviceB')).toBe(true);

            container.clear();

            expect(container.has('serviceA')).toBe(false);
            expect(container.has('serviceB')).toBe(false);
        });
    });
});
