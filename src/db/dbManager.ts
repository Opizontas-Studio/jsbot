import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { assertIsError } from '../utils/assertion.js';
import { logTime } from '../utils/logger.js';

function assertIsDatabase(database: Database | undefined): asserts database is Database {
    if (!(database instanceof Database)) {
        throw new Error('未连接数据库!');
    }
}

type DatabaseOperation = 'run' | 'get' | 'all';

// 自定义数据库错误类
class DatabaseError extends Error {
    private operation: string;
    private details: Record<string, any>;

    constructor(message: string, operation: string, details: Record<string, any> = {}) {
        super(message);
        this.name = 'DatabaseError';
        this.operation = operation;
        this.details = details;
    }
}

class DatabaseManager {
    private db?: Database;
    private cache: Map<string, any>;
    private cacheTimeout: number;

    constructor() {
        this.db = undefined;

        // 修改 LRU 缓存的实例化方式
        this.cache = new Map(); // 暂时使用 Map 替代 LRU
        this.cacheTimeout = 5 * 60 * 1000; // 5分钟过期

        // 确保数据目录存在
        this._ensureDataDirectory();
    }

    private _ensureDataDirectory() {
        try {
            if (!existsSync('./data')) {
                mkdirSync('./data', { recursive: true });
                logTime('已创建数据目录: ./data');
            }
            if (!existsSync('./data/backups')) {
                mkdirSync('./data/backups', { recursive: true });
                logTime('已创建备份目录: ./data/backups');
            }
        } catch (error) {
            assertIsError(error);
            logTime('创建数据目录失败: ' + error.message, true);
            throw new DatabaseError('创建数据目录失败', 'constructor', { error: error.message });
        }
    }

    /**
     * 初始化数据库连接和表结构
     */
    public async connect(): Promise<void> {
        if (this.db) {
            return;
        }

        try {
            const dbPath = path.join('data', 'database.sqlite');

            // 打开数据库连接
            this.db = await open({
                filename: dbPath,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            });

            // 启用WAL模式和外键约束
            await this.db.exec('PRAGMA journal_mode = WAL');
            await this.db.exec('PRAGMA foreign_keys = ON');
            await this.db.exec('PRAGMA synchronous = NORMAL');
            await this.db.exec('PRAGMA cache_size = -2000'); // 2MB cache

            // 创建数据库表
            await this._createTables();

            logTime('数据库初始化完成');
        } catch (error) {
            assertIsError(error);

            this.db = undefined;
            logTime(`数据库连接失败: ${error.message}`, true);
            console.error('数据库连接错误详情:', error);
            throw new DatabaseError('数据库连接失败', 'connect', { error: error.message, stack: error.stack });
        }
    }

    private async _createTables() {
        assertIsDatabase(this.db);
        // 创建处罚表
        await this.db.exec(`
	        CREATE TABLE IF NOT EXISTS punishments (
	            id INTEGER PRIMARY KEY AUTOINCREMENT,
	            userId TEXT NOT NULL,
	            type TEXT NOT NULL CHECK(type IN ('ban', 'mute')),
	            reason TEXT NOT NULL,
	            duration INTEGER NOT NULL DEFAULT -1,
	            warningDuration INTEGER DEFAULT NULL,
	            executorId TEXT NOT NULL,
	            status TEXT NOT NULL DEFAULT 'active' 
	                CHECK(status IN ('active', 'expired', 'appealed', 'revoked')),
	            synced INTEGER DEFAULT 0,
	            syncedServers TEXT DEFAULT '[]',
	            keepMessages INTEGER DEFAULT 0,
	            channelId TEXT,
	            createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
	            updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
	        )
	    `);

        // 创建流程表
        await this.db.exec(`
	        CREATE TABLE IF NOT EXISTS processes (
	            id INTEGER PRIMARY KEY AUTOINCREMENT,
	            type TEXT NOT NULL CHECK(
	                type IN ('appeal', 'vote', 'debate', 'court_mute', 'court_ban')
	            ),
	            targetId TEXT NOT NULL,
	            executorId TEXT NOT NULL,
	            messageId TEXT UNIQUE NOT NULL,
	            statusMessageId TEXT,
	            debateThreadId TEXT,
	            status TEXT NOT NULL DEFAULT 'pending'
	                CHECK(status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
	            expireAt INTEGER NOT NULL,
	            details TEXT DEFAULT '{}',
	            supporters TEXT DEFAULT '[]',
	            result TEXT CHECK(result IN ('approved', 'rejected', 'cancelled', NULL)),
	            reason TEXT DEFAULT '',
	            createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
	            updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
	        )
	    `);

        // 创建索引
        await this.db.exec(`
	        CREATE INDEX IF NOT EXISTS idx_punishments_user ON punishments(userId);
	        CREATE INDEX IF NOT EXISTS idx_punishments_status ON punishments(status, createdAt, duration);
	        CREATE INDEX IF NOT EXISTS idx_punishments_sync ON punishments(synced);
	        CREATE INDEX IF NOT EXISTS idx_processes_target ON processes(targetId);
	        CREATE INDEX IF NOT EXISTS idx_processes_message ON processes(messageId);
	        CREATE INDEX IF NOT EXISTS idx_processes_status_message ON processes(statusMessageId);
	        CREATE INDEX IF NOT EXISTS idx_processes_debate ON processes(debateThreadId);
	        CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status, expireAt);
	        CREATE INDEX IF NOT EXISTS idx_processes_type ON processes(type);
	    `);
    }

    /**
     * 安全执行数据库操作
     * @param operation - 操作类型 ('run', 'get', 'all' 等)
     * @param query - SQL查询
     * @param params - 查询参数
     * @returns 执行结果
     */
    public async safeExecute(operation: DatabaseOperation, query: string, params: any[] = []): Promise<any> {
        if (!this.db) {
            throw new DatabaseError('数据库未连接', operation);
        }

        try {
            return await this.db[operation](query, params);
        } catch (error) {
            assertIsError(error);
            throw new DatabaseError(error.message, operation, { query, params });
        }
    }

    /**
     * 事务支持
     * @param callback - 事务回调
     * @returns
     */
    public async transaction(callback: Function): Promise<any> {
        if (!this.db) {
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
     * @param key - 缓存键
     * @param data - 要缓存的数据
     */
    public setCache(key: string, data: any) {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
        });
    }

    /**
     * 获取缓存
     * @param key - 缓存键
     * @returns 查找结果; 如果没找到则返回 null
     */
    public getCache(key: string): any | null {
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
     * @param key - 缓存键，如果不提供则清除所有缓存
     */
    public clearCache(key?: string) {
        if (key) {
            this.cache.delete(key);
        } else {
            logTime('清除所有缓存');
            this.cache.clear();
        }
    }

    /**
     * 备份数据库
     * @returns {Promise<void>}
     */
    public async backup() {
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
            copyFileSync(path.join('data', 'database.sqlite'), backupPath);

            logTime(`数据库已备份到: ${backupPath}`);
        } catch (error) {
            assertIsError(error);
            logTime(`数据库备份失败: ${error.message}`, true);
            throw new DatabaseError('备份失败', 'backup', { error: error.message });
        }
    }

    /**
     * 关闭数据库连接
     */
    public async disconnect(): Promise<void> {
        if (!this.db) {
            return;
        }

        try {
            await this.db.close();
            this.db = undefined;
            // 修改清除缓存的方法
            this.cache.clear();
            logTime('数据库连接已关闭');
        } catch (error) {
            assertIsError(error);
            logTime(`关闭数据库连接时出错: ${error.message}`, true);
            throw error; // 添加错误抛出以便于调试
        }
    }

    /**
     * 检查数据库连接状态
     */
    public getConnectionStatus(): boolean {
        return this.db !== undefined;
    }

    /**
     * 获取数据库实例
     */
    public getDb(): Database {
        if (!this.db) {
            throw new DatabaseError('数据库未连接', 'getDb');
        }
        return this.db;
    }

    /**
     * 更新数组类型字段
     * @param table - 表名
     * @param field - 字段名
     * @param value - 要添加的值
     * @param where - 查询条件
     * @returns 更新后的记录
     */
    public async updateArrayField(
        table: string,
        field: string,
        value: string,
        where: Record<string, any>,
    ): Promise<Record<string, any>> {
        const whereClause = Object.entries(where)
            .map(([key]) => `${key} = ?`)
            .join(' AND ');
        const whereValues = Object.values(where);

        try {
            // 获取当前记录
            const record = await this.safeExecute('get', `SELECT * FROM ${table} WHERE ${whereClause}`, whereValues);

            if (!record) {
                throw new DatabaseError('记录不存在', 'updateArrayField');
            }

            // 解析当前数组
            let currentArray = [];
            try {
                currentArray = JSON.parse(record[field] || '[]');
            } catch (error) {
                assertIsError(error);
                logTime(`解析${field}失败，使用空数组: ${error.message}`, true);
            }

            // 如果值存在则移除，不存在则添加
            const index = currentArray.indexOf(value);
            if (index !== -1) {
                currentArray.splice(index, 1);
            } else {
                currentArray.push(value);
            }

            // 更新记录
            await this.safeExecute(
                'run',
                `UPDATE ${table} 
	            SET ${field} = ?, updatedAt = ?
	            WHERE ${whereClause}`,
                [JSON.stringify(currentArray), Date.now(), ...whereValues],
            );

            // 返回更新后的记录
            return this.safeExecute('get', `SELECT * FROM ${table} WHERE ${whereClause}`, whereValues);
        } catch (error) {
            assertIsError(error);
            throw new DatabaseError(error.message, 'updateArrayField', { table, field, value, where });
        }
    }
}

export const dbManager = new DatabaseManager();
export default dbManager;
