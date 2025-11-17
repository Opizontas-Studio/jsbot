import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';

/**
 * SQLite 数据库适配器
 */
export class SqliteAdapter {
    /**
     * @param {Object} config - SQLite配置
     * @param {string} config.path - 数据库文件路径
     * @param {Object} [logger] - 日志器
     */
    constructor(config, logger = null) {
        this.config = config;
        this.logger = logger;
        this.db = null;

        this._ensureDataDirectory();
    }

    /**
     * 确保数据目录存在
     * @private
     */
    _ensureDataDirectory() {
        const dbPath = path.dirname(this.config.path);

        if (!existsSync(dbPath)) {
            mkdirSync(dbPath, { recursive: true });
            this.logger?.info(`[SQLite] 创建数据目录: ${dbPath}`);
        }

        const backupPath = path.join(dbPath, 'backups');
        if (!existsSync(backupPath)) {
            mkdirSync(backupPath, { recursive: true });
            this.logger?.info(`[SQLite] 创建备份目录: ${backupPath}`);
        }
    }

    /**
     * 连接数据库
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.db) {
            return;
        }

        try {
            this.db = await open({
                filename: this.config.path,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
            });

            // 启用WAL模式和外键约束
            await this.db.exec('PRAGMA journal_mode = WAL');
            await this.db.exec('PRAGMA foreign_keys = ON');
            await this.db.exec('PRAGMA synchronous = NORMAL');
            await this.db.exec('PRAGMA cache_size = -2000'); // 2MB cache

            // 验证外键约束
            const fkCheck = await this.db.get('PRAGMA foreign_keys');
            if (!fkCheck || fkCheck.foreign_keys !== 1) {
                throw new Error('无法启用外键约束');
            }

            // 创建表结构
            await this._createTables();

            this.logger?.info('[SQLite] 数据库初始化完成');
        } catch (error) {
            this.db = null;
            this.logger?.error('[SQLite] 连接失败:', error);
            throw error;
        }
    }

    /**
     * 创建表结构
     * @private
     */
    async _createTables() {
        // 处罚表
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS punishments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId TEXT NOT NULL,
                guildId TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('ban', 'mute', 'softban', 'warning')),
                reason TEXT NOT NULL,
                duration INTEGER NOT NULL DEFAULT -1,
                warningDuration INTEGER DEFAULT NULL,
                expiresAt INTEGER,
                executorId TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active', 'expired', 'appealed', 'revoked')),
                statusReason TEXT DEFAULT NULL,
                syncedServers TEXT DEFAULT '[]',
                keepMessages INTEGER DEFAULT 0,
                channelId TEXT,
                notificationMessageId TEXT DEFAULT NULL,
                notificationChannelId TEXT DEFAULT NULL,
                createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
                updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            )
        `);

        // PostgreSQL 同步状态表
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS pg_sync_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT UNIQUE NOT NULL,
                last_sync_at INTEGER,
                last_success_at INTEGER,
                member_count INTEGER DEFAULT 0,
                sync_count INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                last_error TEXT,
                priority TEXT DEFAULT 'low' CHECK(priority IN ('high', 'medium', 'low')),
                is_active INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        `);

        // 创建索引
        await this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_punishments_user ON punishments(userId);
            CREATE INDEX IF NOT EXISTS idx_punishments_guild ON punishments(guildId);
            CREATE INDEX IF NOT EXISTS idx_punishments_status ON punishments(status, expiresAt);
            CREATE INDEX IF NOT EXISTS idx_punishments_type ON punishments(type, status);
            CREATE INDEX IF NOT EXISTS idx_punishments_executor ON punishments(executorId);
            CREATE INDEX IF NOT EXISTS idx_punishments_synced ON punishments(syncedServers);
            CREATE INDEX IF NOT EXISTS idx_punishments_expires ON punishments(expiresAt) WHERE expiresAt IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_pg_sync_priority ON pg_sync_state(priority, last_sync_at);
            CREATE INDEX IF NOT EXISTS idx_pg_sync_thread ON pg_sync_state(thread_id);
            CREATE INDEX IF NOT EXISTS idx_pg_sync_active ON pg_sync_state(is_active, priority);
        `);
    }

    /**
     * 执行查询
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Array>} 结果
     */
    async query(query, params = []) {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }
        return await this.db.all(query, params);
    }

    /**
     * 获取单条记录
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Object|null>} 结果
     */
    async get(query, params = []) {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }
        return await this.db.get(query, params);
    }


    /**
     * 执行写操作
     * @param {string} query - SQL查询
     * @param {Array} [params] - 参数
     * @returns {Promise<Object>} 结果 {changes, lastID}
     */
    async run(query, params = []) {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }

        const result = await this.db.run(query, params);
        return {
            changes: result.changes,
            lastID: result.lastID
        };
    }

    /**
     * 执行事务
     * @param {Function} callback - 事务回调
     * @returns {Promise<any>} 结果
     */
    async transaction(callback) {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }

        await this.db.run('BEGIN TRANSACTION');

        try {
            const result = await callback(this.db);
            await this.db.run('COMMIT');
            return result;
        } catch (error) {
            await this.db.run('ROLLBACK');
            throw error;
        }
    }

    /**
     * 从旧表结构迁移数据
     * @param {string} guildId - 默认服务器ID（旧数据缺少此字段）
     * @returns {Promise<Object>} 迁移结果
     */
    async migrateFromLegacy(guildId) {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }

        try {
            // 检查是否存在旧表
            const tables = await this.db.all(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='punishments'"
            );

            if (tables.length === 0) {
                return { success: true, migrated: 0, message: '未发现需要迁移的数据' };
            }

            // 检查是否需要迁移（查看是否有 guildId 字段）
            const tableInfo = await this.db.all("PRAGMA table_info(punishments)");
            const hasGuildId = tableInfo.some(col => col.name === 'guildId');
            const hasExpiresAt = tableInfo.some(col => col.name === 'expiresAt');
            const hasSyncedServers = tableInfo.some(col => col.name === 'syncedServers');

            if (hasGuildId && hasExpiresAt) {
                return { success: true, migrated: 0, message: '表结构已是最新，无需迁移' };
            }

            this.logger?.info('[SQLite] 开始数据迁移...');

            // 创建新表
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS punishments_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    userId TEXT NOT NULL,
                    guildId TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('ban', 'mute', 'softban', 'warning')),
                    reason TEXT NOT NULL,
                    duration INTEGER NOT NULL DEFAULT -1,
                    warningDuration INTEGER DEFAULT NULL,
                    expiresAt INTEGER,
                    executorId TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'expired', 'appealed', 'revoked')),
                    statusReason TEXT DEFAULT NULL,
                    syncedServers TEXT DEFAULT '[]',
                    keepMessages INTEGER DEFAULT 0,
                    channelId TEXT,
                    notificationMessageId TEXT DEFAULT NULL,
                    notificationChannelId TEXT DEFAULT NULL,
                    createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
                    updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
                )
            `);

            // 迁移数据
            let migrateSQL;
            if (hasSyncedServers) {
                // 从有 syncedServers 的旧表迁移
                migrateSQL = `
                    INSERT INTO punishments_new (
                        id, userId, guildId, type, reason, duration, warningDuration,
                        expiresAt, executorId, status, statusReason, syncedServers,
                        keepMessages, channelId, notificationMessageId, notificationChannelId,
                        createdAt, updatedAt
                    )
                    SELECT
                        id, userId, ?, type, reason, duration, warningDuration,
                        CASE
                            WHEN duration > 0 THEN createdAt + duration
                            ELSE NULL
                        END as expiresAt,
                        executorId, status, statusReason,
                        COALESCE(syncedServers, '[]'),
                        keepMessages, channelId, notificationMessageId,
                        COALESCE(notificationGuildId, notificationChannelId) as notificationChannelId,
                        createdAt, updatedAt
                    FROM punishments
                `;
            } else {
                // 从更早期的表迁移（没有 syncedServers）
                migrateSQL = `
                    INSERT INTO punishments_new (
                        id, userId, guildId, type, reason, duration, warningDuration,
                        expiresAt, executorId, status, statusReason, syncedServers,
                        keepMessages, channelId, notificationMessageId, notificationChannelId,
                        createdAt, updatedAt
                    )
                    SELECT
                        id, userId, ?, type, reason, duration, warningDuration,
                        CASE
                            WHEN duration > 0 THEN createdAt + duration
                            ELSE NULL
                        END as expiresAt,
                        executorId, status, statusReason, '[]',
                        keepMessages, channelId, notificationMessageId, notificationChannelId,
                        createdAt, updatedAt
                    FROM punishments
                `;
            }

            const result = await this.db.run(migrateSQL, [guildId]);

            // 重命名表
            await this.db.exec('DROP TABLE punishments');
            await this.db.exec('ALTER TABLE punishments_new RENAME TO punishments');

            // 创建索引
            await this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_punishments_user ON punishments(userId);
                CREATE INDEX IF NOT EXISTS idx_punishments_guild ON punishments(guildId);
                CREATE INDEX IF NOT EXISTS idx_punishments_status ON punishments(status, expiresAt);
                CREATE INDEX IF NOT EXISTS idx_punishments_type ON punishments(type, status);
                CREATE INDEX IF NOT EXISTS idx_punishments_executor ON punishments(executorId);
                CREATE INDEX IF NOT EXISTS idx_punishments_synced ON punishments(syncedServers);
                CREATE INDEX IF NOT EXISTS idx_punishments_expires ON punishments(expiresAt) WHERE expiresAt IS NOT NULL;
            `);

            this.logger?.info(`[SQLite] 迁移完成，共迁移 ${result.changes} 条记录`);

            return {
                success: true,
                migrated: result.changes,
                message: `成功迁移 ${result.changes} 条记录`
            };
        } catch (error) {
            this.logger?.error('[SQLite] 数据迁移失败:', error);
            throw error;
        }
    }

    /**
     * 备份数据库
     * @returns {Promise<string>} 备份文件路径
     */
    async backup() {
        const backupDir = path.join(path.dirname(this.config.path), 'backups');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = `backup_${timestamp}.sqlite`;
        const backupPath = path.join(backupDir, backupFile);

        try {
            // 保留最近5个备份
            const files = readdirSync(backupDir).sort();
            if (files.length >= 5) {
                const oldestFile = files[0];
                unlinkSync(path.join(backupDir, oldestFile));
            }

            // 复制数据库文件
            copyFileSync(this.config.path, backupPath);

            this.logger?.info(`[SQLite] 备份完成: ${backupPath}`);
            return backupPath;
        } catch (error) {
            this.logger?.error('[SQLite] 备份失败:', error);
            throw error;
        }
    }


    /**
     * 检查连接状态
     * @returns {boolean} 是否已连接
     */
    isConnected() {
        return this.db !== null;
    }

    /**
     * 获取底层数据库实例
     * @returns {Database} 数据库实例
     */
    getDb() {
        if (!this.db) {
            throw new Error('[SQLite] 数据库未连接');
        }
        return this.db;
    }

    /**
     * 断开连接
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.db) {
            return;
        }

        try {
            await this.db.close();
            this.db = null;
            this.logger?.info('[SQLite] 连接已断开');
        } catch (error) {
            this.logger?.error('[SQLite] 断开连接时出错:', error);
            throw error;
        }
    }
}
