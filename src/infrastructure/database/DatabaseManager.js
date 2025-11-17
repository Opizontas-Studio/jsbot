import { PostgresAdapter } from './adapters/PostgresAdapter.js';
import { SqliteAdapter } from './adapters/SqliteAdapter.js';

/**
 * 数据库管理器，负责创建和跟踪 SQLite / PostgreSQL 连接状态。
 */
export class DatabaseManager {
    /**
     * @param {Object} config - 数据库配置（来自 config.json）
     */
    constructor(config = {}) {
        this.config = config;
        this.logger = null;
        this.adapters = new Map();
        this.failedTargets = new Set();
    }

    /**
     * 注入日志器实例
     * @param {import('../../core/Logger.js').Logger} logger
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * 初始化所有数据库连接
     */
    async connect() {
        await this._connectTarget('sqlite', SqliteAdapter);
        await this._connectTarget('postgres', PostgresAdapter);
    }

    /**
     * 连接指定数据库类型
     * @private
     */
    async _connectTarget(type, Adapter) {
        const cfg = this.config?.[type];

        if (!cfg) {
            this.failedTargets.add(type);
            this.logger?.warn(`[数据库] 未提供 ${type} 配置，相关功能将被禁用`);
            return;
        }

        if (cfg.enabled === false) {
            this.failedTargets.add(type);
            this.logger?.warn(`[数据库] ${type} 已在配置中禁用`);
            return;
        }

        if (this.adapters.has(type)) {
            return;
        }

        try {
            const adapter = new Adapter(cfg, this.logger);
            await adapter.connect();
            this.adapters.set(type, adapter);
            this.failedTargets.delete(type);
            this.logger?.info(`[数据库] ${type.toUpperCase()} 连接成功`);
        } catch (error) {
            this.failedTargets.add(type);
            this.logger?.error(`[数据库] ${type.toUpperCase()} 连接失败，相关模块应保持关闭状态`, error);
        }
    }

    async query(query, params = [], { target } = {}) {
        const adapter = this._getAdapter(target);
        return await adapter.query(query, params);
    }

    /** 获取单条记录 */
    async get(query, params = [], { target } = {}) {
        const adapter = this._getAdapter(target);
        return await adapter.get(query, params);
    }

    /** 执行写操作 */
    async run(query, params = [], { target } = {}) {
        const adapter = this._getAdapter(target);
        return await adapter.run(query, params);
    }

    /** 执行事务 */
    async transaction(callback, { target } = {}) {
        const adapter = this._getAdapter(target);
        return await adapter.transaction(callback);
    }

    /** 触发备份（如适配器支持） */
    async backup(target = null) {
        const adapter = this._getAdapter(target);

        if (!adapter.backup) {
            throw new Error(`[数据库] ${this._normalizeTarget(target)} 不支持备份操作`);
        }

        return await adapter.backup();
    }

    /** 检查目标数据库是否已连接 */
    isConnected(target = null) {
        const adapter = this.adapters.get(this._normalizeTarget(target));
        return adapter ? adapter.isConnected() : false;
    }

    /** 获取底层适配器实例 */
    getAdapter(target = null) {
        return this._getAdapter(target);
    }

    /** 判断目标数据库是否可以被业务使用 */
    isTargetAvailable(target) {
        const normalized = this._normalizeTarget(target);
        return this.adapters.has(normalized) && !this.failedTargets.has(normalized);
    }

    /** 判断目标数据库是否被禁用/连接失败 */
    isTargetDisabled(target) {
        return this.failedTargets.has(this._normalizeTarget(target));
    }

    async disconnect(target = null) {
        const targets = target ? [this._normalizeTarget(target)] : Array.from(this.adapters.keys());

        for (const type of targets) {
            const adapter = this.adapters.get(type);
            if (!adapter) {
                continue;
            }

            try {
                await adapter.disconnect();
                this.adapters.delete(type);
                this.logger?.info(`[数据库] ${type} 连接已断开`);
            } catch (error) {
                this.logger?.error(`[数据库] 断开 ${type} 时出错:`, error);
                throw error;
            }
        }
    }

    _getAdapter(target = null) {
        const resolved = this._normalizeTarget(target);

        if (this.failedTargets.has(resolved)) {
            throw new Error(`[数据库] ${resolved} 当前不可用`);
        }

        const adapter = this.adapters.get(resolved);
        if (!adapter) {
            throw new Error(`[数据库] ${resolved} 未连接`);
        }

        return adapter;
    }

    _normalizeTarget(target) {
        return target === 'postgres' ? 'postgres' : 'sqlite';
    }
}
