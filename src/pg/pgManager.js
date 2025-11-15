import fs from 'fs';
import path from 'path';
import { Sequelize } from 'sequelize';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

/**
 * PostgreSQL数据库管理器
 * 使用Sequelize ORM管理外部PostgreSQL数据库
 * 与内置SQLite数据库（dbManager.js）隔离
 */
class PgManager {
    constructor() {
        this.sequelize = null;
        this.config = null;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5分钟过期
    }

    /**
     * 加载PostgreSQL配置
     * @private
     */
    _loadConfig() {
        try {
            const configPath = path.join(process.cwd(), 'pg.config.json');
            if (!fs.existsSync(configPath)) {
                throw new Error('PostgreSQL配置文件不存在: pg.config.json');
            }

            const configData = fs.readFileSync(configPath, 'utf8');
            this.config = JSON.parse(configData);

            // 验证配置
            const requiredFields = ['host', 'port', 'database', 'user', 'password'];
            for (const field of requiredFields) {
                if (!this.config[field]) {
                    throw new Error(`PostgreSQL配置缺少必需字段: ${field}`);
                }
            }

            logTime('[数据库] PostgreSQL配置加载成功');
        } catch (error) {
            logTime(`[数据库] PostgreSQL配置加载失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 初始化PostgreSQL连接
     */
    async connect() {
        if (this.sequelize) {
            return;
        }

        try {
            // 加载配置
            this._loadConfig();

            // 创建Sequelize实例
            this.sequelize = new Sequelize({
                dialect: 'postgres',
                host: this.config.host,
                port: this.config.port,
                database: this.config.database,
                username: this.config.user,
                password: this.config.password,
                pool: {
                    max: this.config.max || 20,
                    min: this.config.min || 0,
                    acquire: this.config.connectionTimeoutMillis || 30000,
                    idle: this.config.idleTimeoutMillis || 10000,
                },
                logging: (msg) => {
                    if (this.config.logging !== false) {
                        logTime(`[数据库] PostgreSQL: ${msg}`);
                    }
                },
                define: {
                    timestamps: true,
                    underscored: true,
                },
            });

            // 测试连接
            await this.sequelize.authenticate();
            const [results] = await this.sequelize.query('SELECT NOW()');
            logTime(`[数据库] PostgreSQL连接成功 - 服务器时间: ${results[0].now}`);
        } catch (error) {
            this.sequelize = null;
            logTime(`[数据库] PostgreSQL连接失败: ${error.message}`, true);
            console.error('PostgreSQL连接错误详情:', error);
            throw error;
        }
    }

    /**
     * 执行原始SQL查询
     * @param {string} query - SQL查询语句
     * @param {Object} options - 查询选项
     * @returns {Promise<Array>} 查询结果
     */
    async query(query, options = {}) {
        if (!this.sequelize) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }

        return await ErrorHandler.handleService(
            async () => {
                return await this.sequelize.query(query, {
                    type: Sequelize.QueryTypes.SELECT,
                    ...options,
                });
            },
            'PostgreSQL查询',
            { throwOnError: true }
        );
    }

    /**
     * 执行事务
     * @param {Function} callback - 事务回调函数
     * @returns {Promise<any>} 事务结果
     */
    async transaction(callback) {
        if (!this.sequelize) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }

        return await ErrorHandler.handleService(
            async () => {
                return await this.sequelize.transaction(async (t) => {
                    return await callback(t);
                });
            },
            'PostgreSQL事务',
            { throwOnError: true }
        );
    }

    /**
     * 缓存管理
     * @param {string} key - 缓存键
     * @param {any} data - 要缓存的数据
     */
    setCache(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
        });
    }

    /**
     * 获取缓存
     * @param {string} key - 缓存键
     * @returns {any|null} 查找结果; 如果没找到则返回 null
     */
    getCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            return cached.data;
        }
        if (cached) {
            this.cache.delete(key);
        }
        return null;
    }

    /**
     * 清除缓存
     * @param {string} [key] - 缓存键，如果不提供则清除所有缓存
     */
    clearCache(key) {
        if (key) {
            this.cache.delete(key);
        } else {
            logTime('[数据库] 清除所有PostgreSQL缓存');
            this.cache.clear();
        }
    }

    /**
     * 关闭连接
     */
    async disconnect() {
        if (!this.sequelize) {
            return;
        }

        try {
            await this.sequelize.close();
            this.sequelize = null;
            this.cache.clear();
            logTime('[数据库] PostgreSQL连接已关闭');
        } catch (error) {
            logTime(`[数据库] 关闭PostgreSQL连接时出错: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 检查连接状态
     * @returns {boolean} 连接状态
     */
    getConnectionStatus() {
        return this.sequelize !== null;
    }

    /**
     * 获取Sequelize实例
     * @returns {Sequelize} Sequelize实例
     */
    getSequelize() {
        if (!this.sequelize) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }
        return this.sequelize;
    }

    /**
     * 获取连接池状态信息
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
            waiting: pool.waiting,
        };
    }
}

export const pgManager = new PgManager();
export default pgManager;

