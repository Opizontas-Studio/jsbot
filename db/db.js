import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { logTime } from '../utils/logger.js';
import { mkdirSync } from 'fs';
import path from 'path';

class DatabaseManager {
    constructor() {
        this._isConnected = false;
        this.db = null;
        
        // 确保data目录存在
        try {
            mkdirSync('./data');
        } catch (error) {
            if (error.code !== 'EEXIST') {
                logTime('创建数据目录失败: ' + error.message, true);
            }
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
            // 打开数据库连接
            this.db = await open({
                filename: path.join('data', 'database.sqlite'),
                driver: sqlite3.Database
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
            logTime('数据库连接成功');
        } catch (error) {
            logTime(`数据库连接失败: ${error.message}`, true);
            throw error;
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
            throw new Error('数据库未连接');
        }
        return this.db;
    }
}

export const dbManager = new DatabaseManager();
export default dbManager; 