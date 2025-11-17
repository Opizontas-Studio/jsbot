import { ClientFactory } from '../../core/ClientFactory.js';
import { ApiMonitor } from './ApiMonitor.js';
import { WebSocketMonitor } from './WebSocketMonitor.js';

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

        // 初始化WebSocket监控
        const wsMonitor = new WebSocketMonitor(this.client, this.logger);
        wsMonitor.start();
        this.container.registerInstance('wsMonitor', wsMonitor);
        this.monitors.push(wsMonitor);

        // 初始化API监控
        const apiMonitor = new ApiMonitor(this.client, this.logger);
        apiMonitor.start();
        this.container.registerInstance('apiMonitor', apiMonitor);
        this.monitors.push(apiMonitor);

        this.logger.info('[MonitoringManager] 监控已启动');
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
        this.logger.info('[MonitoringManager] 监控已停止');
    }
}

export { MonitoringManager };

