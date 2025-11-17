/**
 * WebSocket连接监控
 * 负责监控Discord WebSocket连接状态和延迟
 */
class WebSocketMonitor {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
        this.state = {
            lastPing: client.ws.ping,
            disconnectedAt: null,
            reconnectAttempts: 0,
        };
        this.heartbeatInterval = null;
    }

    /**
     * 启动监控
     */
    start() {
        this._registerShardEvents();
        this._startHeartbeat();
        this.logger.debug('[WebSocketMonitor] 已启动');
    }

    /**
     * 停止监控
     */
    stop() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        this.logger.info('[WebSocketMonitor] 已停止');
    }

    /**
     * 注册Shard事件监听
     * @private
     */
    _registerShardEvents() {
        this.client.on('shardDisconnect', (closeEvent, shardId) => {
            this.state.disconnectedAt = Date.now();
            const isNormalClosure = closeEvent.code === 1000 || closeEvent.code === 1001;

            this.logger[isNormalClosure ? 'info' : 'warn']({
                msg: `WebSocket${isNormalClosure ? '正常关闭' : '断开连接'}`,
                shardId,
                code: closeEvent.code,
                reason: closeEvent.reason || '无'
            });
        });

        this.client.on('shardReconnecting', shardId => {
            this.state.reconnectAttempts++;
            const downtime = this.state.disconnectedAt
                ? Math.floor((Date.now() - this.state.disconnectedAt) / 1000)
                : 0;

            this.logger.warn({
                msg: 'WebSocket正在重连',
                shardId,
                attempts: this.state.reconnectAttempts,
                downtime: `${downtime}秒`
            });
        });

        this.client.on('shardResume', (shardId, replayedEvents) => {
            this.logger.info({
                msg: 'WebSocket恢复连接',
                shardId,
                replayedEvents
            });
            this.state.disconnectedAt = null;
            this.state.reconnectAttempts = 0;
        });

        this.client.on('shardReady', shardId => {
            this.state.lastPing = this.client.ws.ping;
            this.logger.info({
                msg: 'WebSocket就绪',
                shardId,
                ping: `${this.client.ws.ping}ms`
            });
        });
    }

    /**
     * 启动心跳检测
     * @private
     */
    _startHeartbeat() {
        // 每分钟检测一次延迟变化
        this.heartbeatInterval = setInterval(() => {
            const currentPing = this.client.ws.ping;
            const pingDiff = Math.abs(currentPing - this.state.lastPing);

            if (pingDiff > 100) {
                this.logger.warn({
                    msg: 'WebSocket延迟变化显著',
                    oldPing: `${this.state.lastPing}ms`,
                    newPing: `${currentPing}ms`,
                    diff: `${pingDiff}ms`
                });
            }

            this.state.lastPing = currentPing;
        }, 60000);
    }

    /**
     * 获取当前状态
     * @returns {Object}
     */
    getState() {
        return {
            ...this.state,
            currentPing: this.client.ws.ping,
            status: this.client.ws.status
        };
    }
}

export { WebSocketMonitor };

