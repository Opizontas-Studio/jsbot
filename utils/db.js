import mongoose from 'mongoose';
import { logTime } from './logger.js';
import { delay } from './helper.js';

class DatabaseManager {
    constructor() {
        this.isConnected = false;
        this.connectionRetries = 0;
        this.maxRetries = 5;
        this.retryDelay = 5000; // 5秒
    }

    /**
     * 初始化数据库连接
     * @param {string} uri - MongoDB连接URI
     * @returns {Promise<void>}
     */
    async connect(uri) {
        if (this.isConnected) {
            logTime('数据库已连接');
            return;
        }

        try {
            await mongoose.connect(uri, {
                serverSelectionTimeoutMS: 5000,
                heartbeatFrequencyMS: 10000,
                maxPoolSize: 10,
                minPoolSize: 1,
                socketTimeoutMS: 45000,
                family: 4,  // 强制使用IPv4
                retryWrites: true
            });

            this.isConnected = true;
            this.connectionRetries = 0;
            logTime('数据库连接成功');

            // 监听连接事件
            mongoose.connection.on('disconnected', () => {
                this.isConnected = false;
                logTime('数据库连接断开', true);
                this.reconnect(uri);
            });

            mongoose.connection.on('error', (err) => {
                logTime(`数据库错误: ${err.message}`, true);
                if (!this.isConnected) {
                    this.reconnect(uri);
                }
            });

        } catch (error) {
            logTime(`数据库连接失败: ${error.message}`, true);
            this.reconnect(uri);
        }
    }

    /**
     * 重新连接数据库
     * @param {string} uri - MongoDB连接URI
     * @private
     */
    async reconnect(uri) {
        if (this.connectionRetries >= this.maxRetries) {
            logTime('达到最大重试次数，停止重连', true);
            return;
        }

        this.connectionRetries++;
        logTime(`尝试重新连接数据库 (${this.connectionRetries}/${this.maxRetries})`);

        await delay(this.retryDelay);
        try {
            await this.connect(uri);
        } catch (err) {
            logTime(`重连失败: ${err.message}`, true);
        }
    }

    /**
     * 关闭数据库连接
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.isConnected) {
            return;
        }

        try {
            await mongoose.disconnect();
            this.isConnected = false;
            logTime('数据库连接已关闭');
        } catch (error) {
            logTime(`关闭数据库连接时出错: ${error.message}`, true);
        }
    }

    /**
     * 检查数据库连接状态
     * @returns {boolean}
     */
    isConnected() {
        return this.isConnected && mongoose.connection.readyState === 1;
    }
}

export const dbManager = new DatabaseManager();
export default dbManager; 