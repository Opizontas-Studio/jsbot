import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

const { Pool } = pg;

/**
 * PostgreSQL数据库管理器
 * 用于连接和管理外部PostgreSQL数据库
 * 与内置SQLite数据库（dbManager.js）隔离
 */
class PgManager {
    constructor() {
        this.pool = null;
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
     * 初始化PostgreSQL连接池
     */
    async connect() {
        if (this.pool) {
            return;
        }

        try {
            // 加载配置
            this._loadConfig();

            // 创建连接池
            this.pool = new Pool({
                host: this.config.host,
                port: this.config.port,
                database: this.config.database,
                user: this.config.user,
                password: this.config.password,
                max: this.config.max || 20,
                idleTimeoutMillis: this.config.idleTimeoutMillis || 30000,
                connectionTimeoutMillis: this.config.connectionTimeoutMillis || 5000,
            });

            // 测试连接
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW()');
            client.release();

            logTime(`[数据库] PostgreSQL连接成功 - 服务器时间: ${result.rows[0].now}`);

            // 设置连接池事件监听
            this.pool.on('error', (err) => {
                logTime(`[数据库] PostgreSQL连接池错误: ${err.message}`, true);
            });

            this.pool.on('connect', () => {
                logTime('[数据库] PostgreSQL新客户端已连接');
            });

            this.pool.on('remove', () => {
                logTime('[数据库] PostgreSQL客户端已断开');
            });
        } catch (error) {
            this.pool = null;
            logTime(`[数据库] PostgreSQL连接失败: ${error.message}`, true);
            console.error('PostgreSQL连接错误详情:', error);
            throw error;
        }
    }

    /**
     * 执行SQL查询
     * @param {string} query - SQL查询语句
     * @param {Array} params - 查询参数
     * @returns {Promise<Object>} 查询结果
     */
    async query(query, params = []) {
        if (!this.pool) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }

        return await ErrorHandler.handleService(
            async () => {
                return await this.pool.query(query, params);
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
        if (!this.pool) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }

        return await ErrorHandler.handleService(
            async () => {
                const client = await this.pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await callback(client);
                    await client.query('COMMIT');
                    return result;
                } catch (error) {
                    await client.query('ROLLBACK');
                    logTime(`[数据库] PostgreSQL事务回滚: ${error.message}`, true);
                    throw error;
                } finally {
                    client.release();
                }
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
     * 关闭连接池
     */
    async disconnect() {
        if (!this.pool) {
            return;
        }

        try {
            await this.pool.end();
            this.pool = null;
            this.cache.clear();
            logTime('[数据库] PostgreSQL连接池已关闭');
        } catch (error) {
            logTime(`[数据库] 关闭PostgreSQL连接池时出错: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 检查连接状态
     * @returns {boolean} 连接状态
     */
    getConnectionStatus() {
        return this.pool !== null;
    }

    /**
     * 获取连接池实例
     * @returns {Pool} 连接池实例
     */
    getPool() {
        if (!this.pool) {
            throw new Error('[数据库] PostgreSQL数据库未连接');
        }
        return this.pool;
    }

    /**
     * 获取连接池状态信息
     * @returns {Object} 连接池状态
     */
    getPoolStatus() {
        if (!this.pool) {
            return null;
        }

        return {
            totalCount: this.pool.totalCount,
            idleCount: this.pool.idleCount,
            waitingCount: this.pool.waitingCount,
        };
    }
}

export const pgManager = new PgManager();
export default pgManager;

