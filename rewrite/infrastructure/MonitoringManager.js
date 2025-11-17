import { ClientFactory } from '../core/ClientFactory.js';
import { ApiCallTracker } from './api/ApiCallTracker.js';
import { ApiMonitor } from './monitoring/ApiMonitor.js';
import { WebSocketMonitor } from './monitoring/WebSocketMonitor.js';

/**
 * 监控管理器
 * 负责初始化和管理所有监控组件
 */
class MonitoringManager {
    constructor(client, container, logger) {
        this.client = client;
        this.container = container;
        this.logger = logger;
        this.monitors = [];
    }

    /**
     * 初始化所有监控
     */
    start() {
        this.logger.debug('[MonitoringManager] 开始初始化监控');

        // 设置Bot状态
        ClientFactory.setPresence(this.client);

        // 1. 初始化WebSocket监控（Gateway连接）
        const wsMonitor = new WebSocketMonitor(this.client, this.logger);
        wsMonitor.start();
        this.container.registerInstance('wsMonitor', wsMonitor);
        this.monitors.push(wsMonitor);

        // 2. 初始化API底层监控（REST事件）
        const apiMonitor = new ApiMonitor(this.client, this.logger);
        apiMonitor.start();
        this.container.registerInstance('apiMonitor', apiMonitor);
        this.monitors.push(apiMonitor);

        // 3. 初始化API调用追踪器（应用层统计）
        const callTracker = new ApiCallTracker();
        this.container.registerInstance('callTracker', callTracker);
        this.monitors.push(callTracker);

        // 4. 将callTracker注入到已存在的ApiClient
        if (this.container.has('apiClient')) {
            const apiClient = this.container.get('apiClient');
            apiClient.callTracker = callTracker;
            this.logger.debug('[MonitoringManager] ApiCallTracker已注入ApiClient');
        }

        this.logger.info('[MonitoringManager] 所有监控组件已启动');
    }

    /**
     * 停止所有监控
     */
    stop() {
        this.logger.debug('[MonitoringManager] 正在停止监控');

        for (const monitor of this.monitors) {
            if (monitor && typeof monitor.stop === 'function') {
                monitor.stop();
            }
        }

        this.monitors = [];
        this.logger.info('[MonitoringManager] 所有监控组件已停止');
    }

    /**
     * 获取所有监控统计
     * @returns {Object} 包含所有监控数据的对象
     */
    getAllStats() {
        const stats = {};

        // WebSocket统计
        if (this.container.has('wsMonitor')) {
            stats.gateway = this.container.get('wsMonitor').getStats();
        }

        // REST底层统计
        if (this.container.has('apiMonitor')) {
            stats.rest = this.container.get('apiMonitor').getStats();
        }

        // API调用统计
        if (this.container.has('callTracker')) {
            stats.apiCalls = this.container.get('callTracker').getStats();
        }

        return stats;
    }

    /**
     * 重置所有监控统计
     */
    resetAllStats() {
        this.logger.debug('[MonitoringManager] 重置所有监控统计');

        if (this.container.has('wsMonitor')) {
            this.container.get('wsMonitor').reset();
        }

        if (this.container.has('apiMonitor')) {
            this.container.get('apiMonitor').reset();
        }

        if (this.container.has('callTracker')) {
            this.container.get('callTracker').reset();
        }

        this.logger.info('[MonitoringManager] 所有监控统计已重置');
    }
}

export { MonitoringManager };

