import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { logTime } from '../utils/logger.js';
import { mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';

// 自定义数据库错误类
class DatabaseError extends Error {
    constructor(message, operation, details = {}) {
        super(message);
        this.name = 'DatabaseError';
        this.operation = operation;
        this.details = details;
    }
}

class DatabaseManager {
    constructor() {
        this._isConnected = false;
        this.db = null;
        this._cache = new Map();
        this._cacheTimeout = 5 * 60 * 1000; // 5分钟缓存过期
        
        // 确保data目录存在
        try {
            if (!existsSync('./data')) {
                mkdirSync('./data', { recursive: true });
                logTime('已创建数据目录: ./data');
            }
        } catch (error) {
            logTime('创建数据目录失败: ' + error.message, true);
            throw new DatabaseError('创建数据目录失败', 'constructor', { error: error.message });
        }
    }

    /**
     * 初始化数据库连接和表结构
     * @returns {Promise<void>}
     */
    async connect() {
        if (this._isConnected) {
            logTime('数据库已连接');
            return;
        }

        try {
            const dbPath = path.join('data', 'database.sqlite');

            // 打开数据库连接
            this.db = await open({
                filename: dbPath,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
            });

            // 启用外键约束
            await this.db.run('PRAGMA foreign_keys = ON');

            // 创建处罚表
            await this.db.run(`
                CREATE TABLE IF NOT EXISTS punishments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    userId TEXT NOT NULL,
                    guildId TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('ban', 'mute', 'warn')),
                    reason TEXT NOT NULL,
                    duration INTEGER NOT NULL,
                    expireAt INTEGER NOT NULL,
                    executorId TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active' 
                        CHECK(status IN ('active', 'expired', 'appealed', 'revoked')),
                    synced INTEGER DEFAULT 0,
                    syncedServers TEXT DEFAULT '[]',
                    createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                    updatedAt INTEGER DEFAULT (strftime('%s', 'now') * 1000)
                )
            `);

            // 创建流程表
            await this.db.run(`
                CREATE TABLE IF NOT EXISTS processes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    punishmentId INTEGER NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('appeal', 'vote', 'debate')),
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
                    createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                    expireAt INTEGER NOT NULL,
                    messageIds TEXT DEFAULT '[]',
                    votes TEXT DEFAULT '{}',
                    result TEXT CHECK(result IN ('approved', 'rejected', 'cancelled', NULL)),
                    reason TEXT DEFAULT '',
                    updatedAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                    FOREIGN KEY(punishmentId) REFERENCES punishments(id) ON DELETE CASCADE
                )
            `);

            // 创建索引
            await this.db.run('CREATE INDEX IF NOT EXISTS idx_punishments_user ON punishments(userId, guildId)');
            await this.db.run('CREATE INDEX IF NOT EXISTS idx_punishments_status ON punishments(status, expireAt)');
            await this.db.run('CREATE INDEX IF NOT EXISTS idx_processes_punishment ON processes(punishmentId)');
            await this.db.run('CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status, expireAt)');

            this._isConnected = true;
            logTime('数据库初始化完成');
        } catch (error) {
            this._isConnected = false;
            this.db = null;
            logTime(`数据库连接失败: ${error.message}`, true);
            console.error('数据库连接错误详情:', error);
            throw new DatabaseError(
                '数据库连接失败',
                'connect',
                { 
                    error: error.message,
                    stack: error.stack
                }
            );
        }
    }

    /**
     * 安全执行数据库操作
     * @param {string} operation - 操作类型 ('run', 'get', 'all' 等)
     * @param {string} query - SQL查询
     * @param {Array} params - 查询参数
     * @returns {Promise<any>}
     */
    async safeExecute(operation, query, params = []) {
        if (!this._isConnected || !this.db) {
            throw new DatabaseError('数据库未连接', operation);
        }

        try {
            return await this.db[operation](query, params);
        } catch (error) {
            throw new DatabaseError(
                error.message,
                operation,
                { query, params }
            );
        }
    }

    /**
     * 事务支持
     * @param {Function} callback - 事务回调
     * @returns {Promise<any>}
     */
    async transaction(callback) {
        if (!this._isConnected) {
            throw new DatabaseError('数据库未连接', 'transaction');
        }

        await this.safeExecute('run', 'BEGIN TRANSACTION');
        try {
            const result = await callback(this.db);
            await this.safeExecute('run', 'COMMIT');
            return result;
        } catch (error) {
            await this.safeExecute('run', 'ROLLBACK');
            throw error;
        }
    }

    /**
     * 缓存管理
     * @param {string} key - 缓存键
     * @param {any} data - 要缓存的数据
     * @returns {void}
     */
    setCache(key, data) {
        this._cache.set(key, {
            timestamp: Date.now(),
            data
        });
    }

    /**
     * 获取缓存
     * @param {string} key - 缓存键
     * @returns {any|null}
     */
    getCache(key) {
        const cached = this._cache.get(key);
        if (cached && (Date.now() - cached.timestamp < this._cacheTimeout)) {
            return cached.data;
        }
        return null;
    }

    /**
     * 清除缓存
     * @param {string} key - 缓存键，如果不提供则清除所有缓存
     */
    clearCache(key = null) {
        if (key) {
            this._cache.delete(key);
        } else {
            this._cache.clear();
        }
    }

    /**
     * 备份数据库
     * @returns {Promise<void>}
     */
    async backup() {
        const backupDir = './data/backups';
        const backupFile = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
        const backupPath = path.join(backupDir, backupFile);

        try {
            // 确保备份目录存在
            if (!existsSync(backupDir)) {
                mkdirSync(backupDir, { recursive: true });
            }

            // 保留最近5个备份
            const files = readdirSync(backupDir);
            if (files.length >= 5) {
                const oldestFile = files.sort()[0];
                unlinkSync(path.join(backupDir, oldestFile));
            }

            // 复制数据库文件
            copyFileSync(
                path.join('data', 'database.sqlite'),
                backupPath
            );
            
            logTime(`数据库已备份到: ${backupPath}`);
        } catch (error) {
            logTime(`数据库备份失败: ${error.message}`, true);
            throw new DatabaseError('备份失败', 'backup', { error: error.message });
        }
    }

    /**
     * 关闭数据库连接
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this._isConnected || !this.db) {
            return;
        }

        try {
            await this.db.close();
            this._isConnected = false;
            this.db = null;
            this._cache.clear();
            logTime('数据库连接已关闭');
        } catch (error) {
            logTime(`关闭数据库连接时出错: ${error.message}`, true);
        }
    }

    /**
     * 检查数据库连接状态
     * @returns {boolean}
     */
    getConnectionStatus() {
        return this._isConnected && this.db !== null;
    }

    /**
     * 获取数据库实例
     * @returns {sqlite.Database}
     */
    getDb() {
        if (!this._isConnected || !this.db) {
            throw new DatabaseError('数据库未连接', 'getDb');
        }
        return this.db;
    }
}

export const dbManager = new DatabaseManager();
export default dbManager; 