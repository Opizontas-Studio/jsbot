import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * 注册中心
 * 负责扫描、注册和路由所有模块配置
 */
class Registry {
    constructor(container, logger) {
        this.container = container;
        this.logger = logger;

        // 路由表
        this.commands = new Map();  // commandName => config
        this.buttons = new Map();  // pattern => { regex, config, extractor }
        this.selectMenus = new Map();  // pattern => { regex, config, extractor }
        this.modals = new Map();  // pattern => { regex, config, extractor }
        this.events = new Map();  // eventName => config[]
        this.tasks = new Map();  // taskId => config

        // 诊断信息
        this.diagnostics = {
            loaded: [],
            failed: []
        };

        // 统计信息
        this.servicesCount = 0;
    }

    /**
     * 扫描并加载所有模块
     * @param {string} modulesPath - 模块目录路径
     * @param {string} [sharedPath] - 共享代码目录路径（可选）
     */
    async loadModules(modulesPath, sharedPath = null) {
        this.logger.debug(`[Registry] 开始扫描模块: ${modulesPath}`);
        const startTime = Date.now();

        try {
            // 先扫描共享目录（如果存在）
            if (sharedPath) {
                this.logger.debug(`[Registry] 扫描共享目录: ${sharedPath}`);
                await this._scanSharedDirectory(sharedPath);
            }

            // 再扫描所有模块目录
            await this._scanModulesDirectory(modulesPath);

            const duration = Date.now() - startTime;
            this.logger.info({
                msg: `[Registry] 模块加载完成 (耗时 ${duration}ms)`,
                stats: {
                    services: this.servicesCount,
                    commands: this.commands.size,
                    buttons: this.buttons.size,
                    selectMenus: this.selectMenus.size,
                    modals: this.modals.size,
                    events: Array.from(this.events.values()).flat().length,
                    tasks: this.tasks.size
                }
            });

            // 记录失败的模块
            if (this.diagnostics.failed.length > 0) {
                this.logger.warn({
                    msg: `[Registry] 部分模块加载失败`,
                    failed: this.diagnostics.failed
                });
            }
        } catch (error) {
            this.logger.error({
                msg: `[Registry] 模块扫描失败`,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 重载指定模块
     * @param {string} moduleName - 模块名称
     * @param {Object} options - 选项
     * @param {string} options.scope - 重载范围：'all' | 'builders'
     * @param {string} options.modulesPath - 模块根目录
     * @param {boolean} options.bustCache - 是否清除缓存
     * @returns {Promise<Object>} 加载统计
     */
    async reloadModule(moduleName, { scope = 'all', modulesPath, bustCache = true }) {
        const modulePath = join(modulesPath, moduleName);
        const loaded = {
            services: 0,
            commands: 0,
            buttons: 0,
            selectMenus: 0,
            modals: 0,
            events: 0,
            tasks: 0
        };

        try {
            // 1. 重载服务（如果是完全重载）
            if (scope === 'all') {
                const servicesPath = join(modulePath, 'services');
                try {
                    const servicesBefore = this.servicesCount;
                    await this._scanServicesDirectory(servicesPath, bustCache);
                    loaded.services = this.servicesCount - servicesBefore;
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        throw error;
                    }
                }
            }

            // 2. 重载配置（registries/）
            const registriesPath = join(modulePath, 'registries');
            try {
                const statsBefore = this._getStats();
                await this._scanRegistriesDirectory(registriesPath, bustCache);
                const statsAfter = this._getStats();

                loaded.commands = statsAfter.commands - statsBefore.commands;
                loaded.buttons = statsAfter.buttons - statsBefore.buttons;
                loaded.selectMenus = statsAfter.selectMenus - statsBefore.selectMenus;
                loaded.modals = statsAfter.modals - statsBefore.modals;
                loaded.events = statsAfter.events - statsBefore.events;
                loaded.tasks = statsAfter.tasks - statsBefore.tasks;
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }

            return loaded;
        } catch (error) {
            this.logger.error({
                msg: `[Registry] 重载模块失败: ${moduleName}`,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 获取当前统计信息
     * @private
     */
    _getStats() {
        return {
            commands: this.commands.size,
            buttons: this.buttons.size,
            selectMenus: this.selectMenus.size,
            modals: this.modals.size,
            events: Array.from(this.events.values()).flat().length,
            tasks: this.tasks.size
        };
    }

    /**
     * 扫描共享目录
     * @private
     * @param {string} sharedPath - 共享代码目录路径
     */
    async _scanSharedDirectory(sharedPath) {
        try {
            // 扫描 shared/services/ 目录
            const servicesPath = join(sharedPath, 'services');
            try {
                await this._scanServicesDirectory(servicesPath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    this.logger.error({
                        msg: `[Registry] 扫描共享服务目录失败`,
                        error: error.message
                    });
                }
            }

            // 扫描 shared/registries/ 目录
            const registriesPath = join(sharedPath, 'registries');
            try {
                await this._scanRegistriesDirectory(registriesPath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    this.logger.error({
                        msg: `[Registry] 扫描共享配置目录失败`,
                        error: error.message
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                msg: `[Registry] 扫描共享目录失败: ${sharedPath}`,
                error: error.message
            });
        }
    }

    /**
     * 扫描所有模块目录
     * @private
     * @param {string} modulesPath - 模块根目录
     */
    async _scanModulesDirectory(modulesPath) {
        try {
            const items = readdirSync(modulesPath, { withFileTypes: true });

            for (const item of items) {
                if (!item.isDirectory()) continue;

                const modulePath = join(modulesPath, item.name);

                // 扫描 services/ 目录并注册服务
                const servicesPath = join(modulePath, 'services');
                try {
                    await this._scanServicesDirectory(servicesPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        this.logger.error({
                            msg: `[Registry] 扫描服务目录失败: ${item.name}`,
                            error: error.message
                        });
                    }
                }

                // 扫描 registries/ 目录并加载声明
                const registriesPath = join(modulePath, 'registries');
                try {
                    await this._scanRegistriesDirectory(registriesPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        this.logger.error({
                            msg: `[Registry] 扫描配置目录失败: ${item.name}`,
                            error: error.message
                        });
                    }
                }
            }
        } catch (error) {
            this.logger.error({
                msg: `[Registry] 扫描模块目录失败: ${modulesPath}`,
                error: error.message
            });
        }
    }

    /**
     * 扫描 services 目录并自动注册服务
     * @private
     * @param {string} servicesPath - services 目录路径
     * @param {boolean} bustCache - 是否清除缓存
     */
    async _scanServicesDirectory(servicesPath, bustCache = false) {
        const items = readdirSync(servicesPath, { withFileTypes: true });

        for (const item of items) {
            if (item.isFile() && item.name.endsWith('.js')) {
                const fullPath = join(servicesPath, item.name);
                await this._loadServiceFile(fullPath, bustCache);
            }
        }
    }

    /**
     * 扫描 registries 目录并加载声明文件
     * @private
     * @param {string} registriesPath - registries 目录路径
     * @param {boolean} bustCache - 是否清除缓存
     */
    async _scanRegistriesDirectory(registriesPath, bustCache = false) {
        const items = readdirSync(registriesPath, { withFileTypes: true });

        for (const item of items) {
            if (item.isFile() && item.name.endsWith('.js')) {
                const fullPath = join(registriesPath, item.name);
                await this._loadConfigFile(fullPath, bustCache);
            }
        }
    }

    /**
     * 加载服务文件并注册到容器
     * @private
     * @param {string} filePath - 文件路径
     * @param {boolean} bustCache - 是否清除 ESM 缓存
     */
    async _loadServiceFile(filePath, bustCache = false) {
        try {
            let fileUrl = pathToFileURL(filePath).href;

            // 添加时间戳参数强制重新加载
            if (bustCache) {
                fileUrl += `?t=${Date.now()}`;
            }

            const module = await import(fileUrl);

            if (!module.serviceConfig) {
                return; // 没有导出 serviceConfig，跳过
            }

            const { name, factory } = module.serviceConfig;
            if (!name || !factory) {
                this.logger.warn({
                    msg: '[Registry] 服务配置缺少 name 或 factory',
                    file: filePath
                });
                return;
            }

            this.container.register(name, factory);
            this.servicesCount++;
            this.logger.debug({
                msg: '[Registry] 服务已注册',
                service: name,
                file: filePath
            });
        } catch (error) {
            this.logger.error({
                msg: '[Registry] 加载服务文件失败',
                file: filePath,
                error: error.message
            });
        }
    }

    /**
     * 加载配置文件
     * @private
     * @param {string} filePath - 文件路径
     * @param {boolean} bustCache - 是否清除 ESM 缓存
     */
    async _loadConfigFile(filePath, bustCache = false) {
        try {
            let fileUrl = pathToFileURL(filePath).href;

            // 添加时间戳参数强制重新加载
            if (bustCache) {
                fileUrl += `?t=${Date.now()}`;
            }

            const module = await import(fileUrl);
            const configs = Array.isArray(module.default) ? module.default : [module.default];

            for (const config of configs) {
                // 跳过无效配置
                if (!config || !config.type || !config.id) {
                    this.diagnostics.failed.push({
                        file: filePath,
                        reason: '缺少必需字段: type 和 id'
                    });
                    continue;
                }

                // 验证配置
                const validation = this._validateConfig(config);
                if (!validation.valid) {
                    this.diagnostics.failed.push({
                        file: filePath,
                        id: config.id,
                        reason: validation.error
                    });
                    continue;
                }

                // 根据类型注册
                this._registerConfig(config, filePath);
            }
        } catch (error) {
            this.diagnostics.failed.push({
                file: filePath,
                reason: error.message
            });
            this.logger.error({
                msg: `[Registry] 加载配置文件失败: ${filePath}`,
                error: error.message
            });
        }
    }

    /**
     * 验证配置
     * @private
     */
    _validateConfig(config) {
        const { type, id } = config;

        switch (type) {
            case 'command':
                if (!config.name || !config.execute) {
                    return { valid: false, error: '命令缺少name或execute' };
                }
                if (config.commandKind === 'slash' && !config.builder) {
                    return { valid: false, error: 'Slash命令需要builder' };
                }
                break;

            case 'button':
            case 'selectMenu':
            case 'modal':
                if (!config.pattern || !config.handle) {
                    return { valid: false, error: `${type}需要pattern和handle` };
                }
                break;

            case 'event':
                if (!config.event || !config.handle) {
                    return { valid: false, error: '事件缺少event或handle' };
                }
                break;

            case 'task':
                if (!config.schedule || !config.execute) {
                    return { valid: false, error: '任务缺少schedule或execute' };
                }
                break;

            default:
                return { valid: false, error: `未知的配置类型: ${type}` };
        }

        return { valid: true };
    }

    /**
     * 注册配置
     * @private
     */
    _registerConfig(config, filePath) {
        try {
            switch (config.type) {
                case 'command':
                    this.commands.set(config.name, config);
                    this.diagnostics.loaded.push({ type: 'command', id: config.id, name: config.name });
                    break;

                case 'button':
                    this._registerInteractionConfig(this.buttons, config, 'button');
                    break;

                case 'selectMenu':
                    this._registerInteractionConfig(this.selectMenus, config, 'selectMenu');
                    break;

                case 'modal':
                    this._registerInteractionConfig(this.modals, config, 'modal');
                    break;

                case 'event':
                    if (!this.events.has(config.event)) {
                        this.events.set(config.event, []);
                    }
                    this.events.get(config.event).push(config);
                    // 按优先级排序（降序）
                    this.events.get(config.event).sort((a, b) => (b.priority || 0) - (a.priority || 0));
                    this.diagnostics.loaded.push({ type: 'event', id: config.id, event: config.event });
                    break;

                case 'task':
                    this.tasks.set(config.id, config);
                    this.diagnostics.loaded.push({ type: 'task', id: config.id, schedule: config.schedule });
                    break;
            }
        } catch (error) {
            this.diagnostics.failed.push({
                file: filePath,
                id: config.id,
                reason: `注册失败: ${error.message}`
            });
        }
    }

    /**
     * 注册交互配置（button/selectMenu/modal）
     * @private
     */
    _registerInteractionConfig(patternMap, config, typeName) {
        const route = this._compilePattern(config.pattern);
        patternMap.set(config.pattern, {
            regex: route.regex,
            config,
            extractor: route.extractor
        });
        this.diagnostics.loaded.push({ type: typeName, id: config.id, pattern: config.pattern });
    }

    /**
     * 编译pattern为正则表达式
     * @private
     * @param {string} pattern - 模式字符串
     * @returns {{regex: RegExp, extractor: Function}}
     */
    _compilePattern(pattern) {
        const paramNames = [];
        const paramTypes = [];

        // 将pattern转换为正则表达式
        // 支持: {name}, {id:int}, {id:snowflake}, {action:enum(a,b)}, {name?}
        const regexStr = pattern.replace(/\{([^}]+)\}/g, (match, param) => {
            const parts = param.split(':');
            const name = parts[0].replace('?', '');
            const optional = param.endsWith('?');
            const type = parts[1];

            paramNames.push(name);
            paramTypes.push({ type, optional });

            if (!type) {
                // 默认匹配任意字符串
                return optional ? '([^_]*)?' : '([^_]+)';
            }

            if (type === 'int') {
                return optional ? '(\\d+)?' : '(\\d+)';
            }

            if (type === 'snowflake') {
                return optional ? '(\\d{17,19})?' : '(\\d{17,19})';
            }

            if (type.startsWith('enum(')) {
                const values = type.slice(5, -1).split(',');
                const enumRegex = values.join('|');
                return optional ? `(${enumRegex})?` : `(${enumRegex})`;
            }

            return optional ? '([^_]*)?' : '([^_]+)';
        });

        const regex = new RegExp(`^${regexStr}$`);

        // 参数提取器
        const extractor = (customId) => {
            const match = customId.match(regex);
            if (!match) return null;

            const params = {};
            for (let i = 0; i < paramNames.length; i++) {
                const value = match[i + 1];
                const name = paramNames[i];
                const { type } = paramTypes[i];

                if (value === undefined) {
                    params[name] = null;
                    continue;
                }

                // 类型转换
                if (type === 'int') {
                    params[name] = parseInt(value, 10);
                } else {
                    params[name] = value;
                }
            }

            return params;
        };

        return { regex, extractor };
    }

    /**
     * 查找命令配置
     * @param {string} commandName - 命令名称
     * @returns {Object|null}
     */
    findCommand(commandName) {
        return this.commands.get(commandName) || null;
    }

    /**
     * 查找按钮配置
     * @param {string} customId - 自定义ID
     * @returns {{config: Object, params: Object}|null}
     */
    findButton(customId) {
        return this._findInteractionConfig(this.buttons, customId);
    }

    /**
     * 查找选择菜单配置
     * @param {string} customId - 自定义ID
     * @returns {{config: Object, params: Object}|null}
     */
    findSelectMenu(customId) {
        return this._findInteractionConfig(this.selectMenus, customId);
    }

    /**
     * 查找模态框配置
     * @param {string} customId - 自定义ID
     * @returns {{config: Object, params: Object}|null}
     */
    findModal(customId) {
        return this._findInteractionConfig(this.modals, customId);
    }

    /**
     * 通用的交互配置查找
     * @private
     */
    _findInteractionConfig(patternMap, customId) {
        for (const [pattern, route] of patternMap) {
            if (route.regex.test(customId)) {
                const params = route.extractor(customId);
                return { config: route.config, params };
            }
        }
        return null;
    }

    /**
     * 获取事件处理器列表
     * @param {string} eventName - 事件名称
     * @returns {Array<Object>}
     */
    getEventHandlers(eventName) {
        return this.events.get(eventName) || [];
    }

    /**
     * 获取所有任务配置
     * @returns {Map<string, Object>}
     */
    getTasks() {
        return this.tasks;
    }

    /**
     * 获取所有命令配置（用于部署）
     * @returns {Array<Object>}
     */
    getCommandsForDeploy() {
        return Array.from(this.commands.values());
    }

    /**
     * 获取诊断信息
     * @returns {Object}
     */
    getDiagnostics() {
        return this.diagnostics;
    }
}

export { Registry };

