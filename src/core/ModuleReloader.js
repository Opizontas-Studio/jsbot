/**
 * 模块热重载服务（核心服务）
 * 负责清理和重新加载指定模块
 * 作为核心服务，可以重载所有业务模块（包括basic）
 */
export class ModuleReloader {
    constructor({ logger, registry, container }) {
        this.logger = logger;
        this.registry = registry;
        this.container = container;
    }

    /**
     * 重载指定模块
     * @param {string} moduleName - 模块名称
     * @param {Object} options - 重载选项
     * @param {string} options.scope - 重载范围：'all' | 'builders'
     * @param {string} options.modulesPath - 模块根目录
     * @param {boolean} options.force - 是否强制重载（忽略活跃操作检查）
     * @returns {Promise<Object>} 重载结果
     */
    async reloadModule(moduleName, { scope = 'all', modulesPath, force = false }) {
        const startTime = Date.now();

        // 检查活跃操作
        if (!force && this.container.has('activeOperationTracker')) {
            const tracker = this.container.get('activeOperationTracker');
            const activeOps = tracker.getActiveOperations(moduleName);

            if (activeOps.length > 0) {
                const warning = {
                    hasActiveOperations: true,
                    activeOperations: activeOps,
                    message: `模块 ${moduleName} 有 ${activeOps.length} 个活跃操作正在执行`
                };
                this.logger.warn({
                    msg: '[ModuleReload] 检测到活跃操作',
                    ...warning
                });
                throw new Error(warning.message + '，请稍后重试或使用强制重载');
            }
        }

        this.logger.debug({
            msg: '[ModuleReload] 开始重载模块',
            module: moduleName,
            scope,
            force
        });

        try {
            // 1. 清除模块的注册信息
            const cleared = this._clearModuleRegistrations(moduleName);

            // 2. 清除模块服务实例（如果是完全重载）
            if (scope === 'all') {
                this._clearModuleServices(moduleName);
            }

            // 3. 重新加载模块
            const loaded = await this.registry.reloadModule(moduleName, {
                scope,
                modulesPath,
                bustCache: true
            });

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            this.logger.info({
                msg: '[ModuleReload] 模块重载完成',
                module: moduleName,
                scope,
                duration: `${duration}s`,
                cleared,
                loaded
            });

            return {
                success: true,
                module: moduleName,
                scope,
                duration,
                cleared,
                loaded
            };
        } catch (error) {
            this.logger.error({
                msg: '[ModuleReload] 模块重载失败',
                module: moduleName,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * 获取可重载的模块列表
     * @param {string} modulesPath - 模块根目录
     * @returns {Promise<Array<string>>} 模块名称列表
     */
    async getReloadableModules(modulesPath) {
        try {
            const { readdirSync } = await import('fs');
            const items = readdirSync(modulesPath, { withFileTypes: true });
            return items
                .filter(item => item.isDirectory())
                .map(item => item.name);
        } catch (error) {
            this.logger.error({
                msg: '[ModuleReload] 读取模块列表失败',
                error: error.message
            });
            return [];
        }
    }

    /**
     * 清除模块的所有注册信息
     * @private
     */
    _clearModuleRegistrations(moduleName) {
        const cleared = {
            commands: 0,
            buttons: 0,
            selectMenus: 0,
            modals: 0,
            events: 0,
            tasks: 0
        };

        // 清除命令
        for (const [name, config] of this.registry.commands) {
            if (config.id.startsWith(`${moduleName}.`)) {
                this.registry.commands.delete(name);
                cleared.commands++;
            }
        }

        // 清除按钮
        for (const [pattern, route] of this.registry.buttons) {
            if (route.config.id.startsWith(`${moduleName}.`)) {
                this.registry.buttons.delete(pattern);
                cleared.buttons++;
            }
        }

        // 清除选择菜单
        for (const [pattern, route] of this.registry.selectMenus) {
            if (route.config.id.startsWith(`${moduleName}.`)) {
                this.registry.selectMenus.delete(pattern);
                cleared.selectMenus++;
            }
        }

        // 清除模态框
        for (const [pattern, route] of this.registry.modals) {
            if (route.config.id.startsWith(`${moduleName}.`)) {
                this.registry.modals.delete(pattern);
                cleared.modals++;
            }
        }

        // 清除事件
        for (const [eventName, handlers] of this.registry.events) {
            const filtered = handlers.filter(h => !h.id.startsWith(`${moduleName}.`));
            const removed = handlers.length - filtered.length;
            if (removed > 0) {
                if (filtered.length === 0) {
                    this.registry.events.delete(eventName);
                } else {
                    this.registry.events.set(eventName, filtered);
                }
                cleared.events += removed;
            }
        }

        // 清除定时任务
        for (const [taskId, config] of this.registry.tasks) {
            if (config.id.startsWith(`${moduleName}.`)) {
                this.registry.tasks.delete(taskId);
                cleared.tasks++;
            }
        }

        return cleared;
    }

    /**
     * 清除模块的服务实例
     * @private
     */
    _clearModuleServices(moduleName) {
        const prefix = `${moduleName}.`;
        let cleared = 0;

        // 清除服务实例
        for (const [serviceName] of this.container.services) {
            if (serviceName.startsWith(prefix)) {
                this.container.services.delete(serviceName);
                cleared++;
                this.logger.debug({
                    msg: '[ModuleReload] 已清除服务实例',
                    service: serviceName
                });
            }
        }

        // 清除服务工厂
        for (const [serviceName] of this.container.factories) {
            if (serviceName.startsWith(prefix)) {
                this.container.factories.delete(serviceName);
                this.logger.debug({
                    msg: '[ModuleReload] 已清除服务工厂',
                    service: serviceName
                });
            }
        }

        return cleared;
    }
}
