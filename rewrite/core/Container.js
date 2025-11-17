/**
 * 依赖注入容器
 * 基于Map的服务容器，支持工厂函数和单例
 */
class Container {
    constructor() {
        /** @type {Map<string, any>} */
        this.services = new Map();
        /** @type {Map<string, Function>} */
        this.factories = new Map();
        /** @type {Set<string>} */
        this.resolving = new Set();
    }

    /**
     * 注册服务工厂函数
     * @param {string} name - 服务名称
     * @param {Function} factory - 工厂函数
     */
    register(name, factory) {
        if (typeof factory !== 'function') {
            throw new Error(`Factory for ${name} must be a function`);
        }
        this.factories.set(name, factory);
    }

    /**
     * 注册单例实例
     * @param {string} name - 服务名称
     * @param {any} instance - 服务实例
     */
    registerInstance(name, instance) {
        this.services.set(name, instance);
    }

    /**
     * 获取服务实例
     * @param {string} name - 服务名称
     * @returns {any} 服务实例
     */
    get(name) {
        // 检查是否已实例化
        if (this.services.has(name)) {
            return this.services.get(name);
        }

        // 检查是否有工厂函数
        if (!this.factories.has(name)) {
            throw new Error(`Service ${name} not found in container`);
        }

        // 检测循环依赖
        if (this.resolving.has(name)) {
            throw new Error(`Circular dependency detected: ${name}`);
        }

        // 标记正在解析
        this.resolving.add(name);

        try {
            const factory = this.factories.get(name);
            const instance = factory(this);

            // 缓存实例（单例）
            this.services.set(name, instance);

            return instance;
        } finally {
            this.resolving.delete(name);
        }
    }

    /**
     * 检查服务是否存在
     * @param {string} name - 服务名称
     * @returns {boolean}
     */
    has(name) {
        return this.services.has(name) || this.factories.has(name);
    }

    /**
     * 解析依赖列表
     * @param {Array<string>} dependencies - 依赖服务名称列表
     * @returns {Object} 依赖对象
     */
    resolve(dependencies = []) {
        const resolved = {};
        for (const dep of dependencies) {
            const service = this.get(dep);

            // 使用完整名称作为键
            resolved[dep] = service;

            // 如果包含点号（模块前缀），同时也提供短名称作为键
            const dotIndex = dep.lastIndexOf('.');
            if (dotIndex > 0) {
                const shortName = dep.substring(dotIndex + 1);
                // 只在短名称不冲突时添加
                if (!resolved[shortName]) {
                    resolved[shortName] = service;
                }
            }
        }
        return resolved;
    }

    /**
     * 验证所有服务是否可解析（启动时检查）
     * @returns {Array<{service: string, error: string}>} 错误列表
     */
    validateAll() {
        const errors = [];
        for (const [name] of this.factories) {
            try {
                this.get(name);
            } catch (error) {
                errors.push({ service: name, error: error.message });
            }
        }
        return errors;
    }

    /**
     * 清除所有服务
     */
    clear() {
        this.services.clear();
        this.factories.clear();
        this.resolving.clear();
    }
}

/**
 * 定义服务的语法糖
 * 自动处理依赖注入，减少样板代码
 *
 * @param {string} name - 服务名称
 * @param {class} ServiceClass - 服务类（需要定义静态属性 dependencies）
 * @returns {Object} serviceConfig 对象
 *
 * @example
 * export class MyService {
 *     static dependencies = ['logger', 'basic.otherService'];
 *
 *     constructor(deps) {
 *         Object.assign(this, deps);
 *         // this.logger 和 this.otherService 已自动注入
 *     }
 * }
 *
 * export const serviceConfig = defineService('myModule.myService', MyService);
 */
export function defineService(name, ServiceClass) {
    const dependencies = ServiceClass.dependencies || [];

    return {
        name,
        factory: (container) => {
            // 利用 Container.resolve() 自动处理依赖
            // 支持自动提取短名称（如 'basic.otherService' -> 'otherService'）
            const deps = container.resolve(dependencies);
            return new ServiceClass(deps);
        }
    };
}

export { Container };

