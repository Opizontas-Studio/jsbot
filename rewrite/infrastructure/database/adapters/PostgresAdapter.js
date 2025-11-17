import fs from 'fs';
import path from 'path';
import { Sequelize } from 'sequelize';

/**
 * PostgreSQL 数据库适配器
 */
export class PostgresAdapter {
    /**
     * @param {Object} config - PostgreSQL配置
     * @param {string} config.host - 主机地址
     * @param {number} config.port - 端口
     * @param {string} config.database - 数据库名
     * @param {string} config.user - 用户名
     * @param {string} config.password - 密码
     * @param {number} [config.max] - 最大连接数
     * @param {number} [config.idleTimeoutMillis] - 空闲超时时间
     * @param {Object} [logger] - 日志器
     */
    constructor(config, logger = null) {
        this.config = config;
        this.logger = logger;
        this.sequelize = null;
    }

    /**
     * 加载外部PostgreSQL配置
     * @private
     */
    _loadExternalConfig() {
        const configPath = path.join(process.cwd(), 'pg.config.json');

        if (!fs.existsSync(configPath)) {
            throw new Error('PostgreSQL配置文件不存在: pg.config.json');
        }

        const configData = fs.readFileSync(configPath, 'utf8');
        const externalConfig = JSON.parse(configData);

        // 合并配置
        return {
            ...this.config,
            ...externalConfig
        };
    }

    /**
     * 连接数据库
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.sequelize) {
            return;
        }

        try {
            // 尝试加载外部配置（如果存在）
            let finalConfig = this.config;
            try {
                finalConfig = this._loadExternalConfig();
                this.logger?.info('[PostgreSQL] 使用外部配置文件');
            } catch (error) {
                this.logger?.debug('[PostgreSQL] 未找到外部配置，使用内部配置');
            }

            // 创建Sequelize实例
            this.sequelize = new Sequelize({
                dialect: 'postgres',
                host: finalConfig.host,
                port: finalConfig.port,
                database: finalConfig.database,
                username: finalConfig.user,
                password: finalConfig.password,
                pool: {
                    max: finalConfig.max || 20,
                    min: finalConfig.min || 0,
                    acquire: finalConfig.connectionTimeoutMillis || 30000,
                    idle: finalConfig.idleTimeoutMillis || 10000
                },
                logging: finalConfig.logging !== false
                    ? (msg) => this.logger?.debug(`[PostgreSQL] ${msg}`)
                    : false,
                define: {
                    timestamps: true,
                    underscored: true
                }
            });

            // 测试连接
            await this.sequelize.authenticate();
            const [results] = await this.sequelize.query('SELECT NOW()');
            this.logger?.info(`[PostgreSQL] 连接成功 - 服务器时间: ${results[0].now}`);
        } catch (error) {
            this.sequelize = null;
            this.logger?.error('[PostgreSQL] 连接失败:', error);
            throw error;
        }
    }


    /**
     * 执行原始SQL查询
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Array>} 结果
     */
    async query(query, params = []) {
        if (!this.sequelize) {
            throw new Error('[PostgreSQL] 数据库未连接');
        }

        const [results] = await this.sequelize.query(query, {
            replacements: params
        });

        return results;
    }

    /**
     * 获取单条记录
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Object|null>} 结果
     */
    async get(query, params = []) {
        const results = await this.query(query, params);
        return results.length > 0 ? results[0] : null;
    }


    /**
     * 执行写操作
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Object>} 结果 {changes, lastID}
     */
    async run(query, params = []) {
        if (!this.sequelize) {
            throw new Error('[PostgreSQL] 数据库未连接');
        }

        const [results, metadata] = await this.sequelize.query(query, {
            replacements: params
        });

        // PostgreSQL 返回的元数据格式与 SQLite 不同
        return {
            changes: metadata.rowCount || 0,
            lastID: results && results.length > 0 ? results[0].id : null
        };
    }

    /**
     * 执行事务
     * @param {Function} callback - 事务回调
     * @returns {Promise<any>} 结果
     */
    async transaction(callback) {
        if (!this.sequelize) {
            throw new Error('[PostgreSQL] 数据库未连接');
        }

        return await this.sequelize.transaction(async (t) => {
            return await callback(t);
        });
    }

    /**
     * 获取连接池状态
     * @returns {Object|null} 连接池状态
     */
    getPoolStatus() {
        if (!this.sequelize) {
            return null;
        }

        const pool = this.sequelize.connectionManager.pool;
        return {
            size: pool.size,
            available: pool.available,
            using: pool.using,
            waiting: pool.waiting
        };
    }

    /**
     * 检查连接状态
     * @returns {boolean} 是否已连接
     */
    isConnected() {
        return this.sequelize !== null;
    }

    /**
     * 获取底层Sequelize实例（供模块直接使用）
     * @returns {Sequelize} Sequelize实例
     */
    getSequelize() {
        if (!this.sequelize) {
            throw new Error('[PostgreSQL] 数据库未连接');
        }
        return this.sequelize;
    }

    /**
     * 断开连接
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.sequelize) {
            return;
        }

        try {
            await this.sequelize.close();
            this.sequelize = null;
            this.logger?.info('[PostgreSQL] 连接已断开');
        } catch (error) {
            this.logger?.error('[PostgreSQL] 断开连接时出错:', error);
            throw error;
        }
    }
}

