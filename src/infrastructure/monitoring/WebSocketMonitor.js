import { Status } from 'discord.js';

/**
 * WebSocket连接监控
 * 监控Discord Gateway WebSocket连接状态、延迟和连接质量
 */
export class WebSocketMonitor {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;

        // 事件监听器引用（用于清理）
        this.listeners = [];

        // 定时器引用
        this.intervals = [];

        // 连接状态
        this.state = {
            lastPing: -1,
            avgPing: -1,
            disconnectedAt: null,
            connectedAt: null,
            totalReconnects: 0,
            currentStatus: 'IDLE'
        };

        // 统计信息
        this.stats = {
            // 连接统计
            connects: 0,
            disconnects: 0,
            reconnects: 0,
            resumes: 0,

            // 延迟统计
            pingHistory: [], // 最近的ping值
            maxPingHistory: 20, // 保留最近20个ping值

            // 断线统计
            totalDowntime: 0, // 累计断线时间（毫秒）
            longestDowntime: 0 // 最长断线时间（毫秒）
        };
    }

    /**
     * 启动监控
     */
    start() {
        this._registerShardEvents();
        this._startHeartbeat();

        // 记录初始状态
        this.state.lastPing = this.client.ws.ping;
        this.state.currentStatus = this._getStatusName(this.client.ws.status);
        this.state.connectedAt = Date.now();

        this.logger.debug('[WebSocketMonitor] Gateway连接监控已启动');
    }

    /**
     * 停止监控
     */
    stop() {
        // 清理所有定时器
        for (const intervalId of this.intervals) {
            clearInterval(intervalId);
        }
        this.intervals = [];

        // 移除所有事件监听器
        for (const { emitter, eventName, listener } of this.listeners) {
            if (emitter && listener) {
                emitter.off(eventName, listener);
            }
        }
        this.listeners = [];

        this.logger.debug('[WebSocketMonitor] 监控已停止');
    }

    /**
     * 注册Shard事件监听
     * @private
     */
    _registerShardEvents() {
        // 监听断开连接
        const shardDisconnectListener = (closeEvent, shardId) => {
            this.stats.disconnects++;
            this.state.disconnectedAt = Date.now();

            const isNormal = closeEvent.code === 1000 || closeEvent.code === 1001;
            const logLevel = isNormal ? 'info' : 'warn';

            this.logger[logLevel]({
                msg: `[Gateway] Shard ${shardId} ${isNormal ? '正常关闭' : '断开连接'}`,
                code: closeEvent.code,
                reason: closeEvent.reason || '无',
                wasClean: closeEvent.wasClean
            });

            this.state.currentStatus = 'DISCONNECTED';
        };

        // 监听重连中
        const shardReconnectingListener = shardId => {
            this.stats.reconnects++;
            this.state.totalReconnects++;

            const downtime = this.state.disconnectedAt ? Date.now() - this.state.disconnectedAt : 0;

            this.logger.warn({
                msg: `[Gateway] Shard ${shardId} 正在重连`,
                attempt: this.state.totalReconnects,
                downtime: `${(downtime / 1000).toFixed(1)}秒`
            });

            this.state.currentStatus = 'RECONNECTING';
        };

        // 监听连接恢复
        const shardResumeListener = (shardId, replayedEvents) => {
            this.stats.resumes++;

            const downtime = this.state.disconnectedAt ? Date.now() - this.state.disconnectedAt : 0;

            if (downtime > 0) {
                this.stats.totalDowntime += downtime;
                this.stats.longestDowntime = Math.max(this.stats.longestDowntime, downtime);
            }

            this.logger.info({
                msg: `[Gateway] Shard ${shardId} 恢复连接`,
                replayedEvents,
                downtime: `${(downtime / 1000).toFixed(1)}秒`
            });

            this.state.disconnectedAt = null;
            this.state.connectedAt = Date.now();
            this.state.currentStatus = 'READY';
        };

        // 监听就绪
        const shardReadyListener = shardId => {
            this.stats.connects++;

            const currentPing = this.client.ws.ping;
            this.state.lastPing = currentPing;
            this._recordPing(currentPing);

            // 如果有断线时间，记录统计
            if (this.state.disconnectedAt) {
                const downtime = Date.now() - this.state.disconnectedAt;
                this.stats.totalDowntime += downtime;
                this.stats.longestDowntime = Math.max(this.stats.longestDowntime, downtime);
                this.state.disconnectedAt = null;
            }

            this.logger.info({
                msg: `[Gateway] Shard ${shardId} 就绪`,
                ping: `${currentPing}ms`,
                guilds: this.client.guilds.cache.size
            });

            this.state.connectedAt = Date.now();
            this.state.currentStatus = 'READY';
        };

        // 监听错误
        const shardErrorListener = (error, shardId) => {
            this.logger.error({
                msg: `[Gateway] Shard ${shardId} 错误`,
                error: error.message,
                code: error.code
            });
        };

        // 注册事件监听器
        this.client.on('shardDisconnect', shardDisconnectListener);
        this.listeners.push({
            emitter: this.client,
            eventName: 'shardDisconnect',
            listener: shardDisconnectListener
        });

        this.client.on('shardReconnecting', shardReconnectingListener);
        this.listeners.push({
            emitter: this.client,
            eventName: 'shardReconnecting',
            listener: shardReconnectingListener
        });

        this.client.on('shardResume', shardResumeListener);
        this.listeners.push({
            emitter: this.client,
            eventName: 'shardResume',
            listener: shardResumeListener
        });

        this.client.on('shardReady', shardReadyListener);
        this.listeners.push({
            emitter: this.client,
            eventName: 'shardReady',
            listener: shardReadyListener
        });

        this.client.on('shardError', shardErrorListener);
        this.listeners.push({
            emitter: this.client,
            eventName: 'shardError',
            listener: shardErrorListener
        });
    }

    /**
     * 启动心跳检测
     * @private
     */
    _startHeartbeat() {
        // 每30秒检测一次延迟
        const heartbeatInterval = setInterval(() => {
            const currentPing = this.client.ws.ping;

            // 记录ping值
            this._recordPing(currentPing);

            // 计算平均ping
            this.state.avgPing = this._calculateAvgPing();

            // 检查延迟异常
            const pingDiff = Math.abs(currentPing - this.state.lastPing);

            if (currentPing > 300) {
                this.logger.warn({
                    msg: '[Gateway] 高延迟警告',
                    currentPing: `${currentPing}ms`,
                    avgPing: `${this.state.avgPing}ms`,
                    status: this.state.currentStatus
                });
            } else if (pingDiff > 150) {
                this.logger.debug({
                    msg: '[Gateway] 延迟波动',
                    oldPing: `${this.state.lastPing}ms`,
                    newPing: `${currentPing}ms`,
                    diff: `${pingDiff}ms`
                });
            }

            this.state.lastPing = currentPing;
            this.state.currentStatus = this._getStatusName(this.client.ws.status);
        }, 30000);
        this.intervals.push(heartbeatInterval);
    }

    /**
     * 记录ping值到历史
     * @private
     */
    _recordPing(ping) {
        if (ping >= 0) {
            this.stats.pingHistory.push(ping);

            // 限制历史长度
            if (this.stats.pingHistory.length > this.stats.maxPingHistory) {
                this.stats.pingHistory.shift();
            }
        }
    }

    /**
     * 计算平均ping
     * @private
     */
    _calculateAvgPing() {
        if (this.stats.pingHistory.length === 0) return -1;

        const sum = this.stats.pingHistory.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.stats.pingHistory.length);
    }

    /**
     * 获取状态名称
     * @private
     */
    _getStatusName(status) {
        const statusNames = {
            [Status.Ready]: 'READY',
            [Status.Connecting]: 'CONNECTING',
            [Status.Reconnecting]: 'RECONNECTING',
            [Status.Idle]: 'IDLE',
            [Status.Nearly]: 'NEARLY',
            [Status.Disconnected]: 'DISCONNECTED',
            [Status.WaitingForGuilds]: 'WAITING_FOR_GUILDS',
            [Status.Identifying]: 'IDENTIFYING',
            [Status.Resuming]: 'RESUMING'
        };

        return statusNames[status] || 'UNKNOWN';
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        const uptime = this.state.connectedAt ? Date.now() - this.state.connectedAt : 0;

        const uptimeSeconds = Math.floor(uptime / 1000);
        const uptimePercent =
            uptime + this.stats.totalDowntime > 0
                ? ((uptime / (uptime + this.stats.totalDowntime)) * 100).toFixed(2)
                : 100;

        return {
            connection: {
                status: this.state.currentStatus,
                uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
                uptimePercent: `${uptimePercent}%`,
                totalReconnects: this.state.totalReconnects
            },
            latency: {
                current: this.state.lastPing >= 0 ? `${this.state.lastPing}ms` : 'N/A',
                average: this.state.avgPing >= 0 ? `${this.state.avgPing}ms` : 'N/A',
                min: this.stats.pingHistory.length > 0 ? `${Math.min(...this.stats.pingHistory)}ms` : 'N/A',
                max: this.stats.pingHistory.length > 0 ? `${Math.max(...this.stats.pingHistory)}ms` : 'N/A'
            },
            events: {
                connects: this.stats.connects,
                disconnects: this.stats.disconnects,
                reconnects: this.stats.reconnects,
                resumes: this.stats.resumes
            },
            downtime: {
                total: `${(this.stats.totalDowntime / 1000).toFixed(1)}秒`,
                longest: `${(this.stats.longestDowntime / 1000).toFixed(1)}秒`
            }
        };
    }

    /**
     * 获取当前状态（简化版）
     * @returns {Object} 当前状态
     */
    getState() {
        return {
            status: this.state.currentStatus,
            ping: this.state.lastPing,
            avgPing: this.state.avgPing,
            reconnects: this.state.totalReconnects,
            isConnected: this.client.ws.status === Status.Ready
        };
    }

    /**
     * 重置统计信息
     */
    reset() {
        this.stats.connects = 0;
        this.stats.disconnects = 0;
        this.stats.reconnects = 0;
        this.stats.resumes = 0;
        this.stats.pingHistory = [];
        this.stats.totalDowntime = 0;
        this.stats.longestDowntime = 0;
        this.state.totalReconnects = 0;

        this.logger.debug('[WebSocketMonitor] 统计已重置');
    }
}
