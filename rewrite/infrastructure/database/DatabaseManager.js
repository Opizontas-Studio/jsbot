/**
 * 数据库管理器
 * 提供统一的数据库接口，支持 SQLite 和 PostgreSQL
 */
export class DatabaseManager {
    /**
     * @param {Object} config - 数据库配置
     * @param {string} config.type - 数据库类型 ('sqlite' | 'postgres')
     * @param {Object} config.sqlite - SQLite配置
     * @param {Object} config.postgres - PostgreSQL配置
     */
    constructor(config) {
        this.config = config;
        this.type = config.type;
        this.adapter = null;
        this.logger = null; // 将由容器注入
    }

    /**
     * 设置日志器（容器注入后调用）
     * @param {Object} logger - 日志器实例
     */
    setLogger(logger) {
        this.logger = logger;
    }

    /**
     * 连接数据库
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.adapter) {
            this.logger?.warn('[数据库] 已经连接，跳过重复连接');
            return;
        }

        try {
            // 动态导入对应的适配器
            if (this.type === 'sqlite') {
                const { SqliteAdapter } = await import('./adapters/SqliteAdapter.js');
                this.adapter = new SqliteAdapter(this.config.sqlite, this.logger);
            } else if (this.type === 'postgres') {
                const { PostgresAdapter } = await import('./adapters/PostgresAdapter.js');
                this.adapter = new PostgresAdapter(this.config.postgres, this.logger);
            } else {
                throw new Error(`不支持的数据库类型: ${this.type}`);
            }

            await this.adapter.connect();
            this.logger?.info(`[数据库] ${this.type.toUpperCase()} 连接成功`);
        } catch (error) {
            this.logger?.error(`[数据库] 连接失败:`, error);
            throw error;
        }
    }

    /**
     * 执行查询
     * @param {string} query - SQL查询
     * @param {Array} [params] - 查询参数
     * @returns {Promise<Array>} 查询结果
     */
    async query(query, params = []) {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }

        return await this.adapter.query(query, params);
    }

    /**
     * 获取单条记录
     * @param {string} query - SQL查询
     * @param {Array} [params] - 查询参数
     * @returns {Promise<Object|null>} 查询结果
     */
    async get(query, params = []) {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }

        return await this.adapter.get(query, params);
    }

    /**
     * 执行写操作（INSERT/UPDATE/DELETE）
     * @param {string} query - SQL查询
     * @param {Array} [params] - 查询参数
     * @returns {Promise<Object>} 执行结果 {changes, lastID}
     */
    async run(query, params = []) {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }

        return await this.adapter.run(query, params);
    }

    /**
     * 执行事务
     * @param {Function} callback - 事务回调函数
     * @returns {Promise<any>} 事务结果
     */
    async transaction(callback) {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }

        return await this.adapter.transaction(callback);
    }


    /**
     * 备份数据库
     * @returns {Promise<string>} 备份文件路径
     */
    async backup() {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }

        if (!this.adapter.backup) {
            throw new Error(`[数据库] ${this.type} 不支持备份操作`);
        }

        return await this.adapter.backup();
    }

    /**
     * 检查连接状态
     * @returns {boolean} 是否已连接
     */
    isConnected() {
        return this.adapter !== null && this.adapter.isConnected();
    }

    /**
     * 获取底层适配器（用于特殊操作）
     * @returns {Object} 适配器实例
     */
    getAdapter() {
        if (!this.adapter) {
            throw new Error('[数据库] 数据库未连接');
        }
        return this.adapter;
    }

    /**
     * 断开数据库连接
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.adapter) {
            return;
        }

        try {
            await this.adapter.disconnect();
            this.adapter = null;
            this.logger?.info('[数据库] 连接已断开');
        } catch (error) {
            this.logger?.error('[数据库] 断开连接时出错:', error);
            throw error;
        }
    }
}

