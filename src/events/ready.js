import { Events } from 'discord.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { createApplicationMessage, createSyncMessage } from '../services/roleApplication.js';
import { logTime } from '../utils/logger.js';

// 添加重连计数器和时间记录
let reconnectionCount = 0;
let reconnectionTimeout = null;

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        logTime(`已登录: ${client.user.tag}`);

        // 初始化所有定时任务
        globalTaskScheduler.initialize(client);

        // 初始化身份组申请消息
        await createApplicationMessage(client);
        
        // 初始化身份组同步消息
        await createSyncMessage(client);

        // 初始化WebSocket状态监控
        const wsStateMonitor = {
            lastPing: client.ws.ping,
            disconnectedAt: null,
            reconnectAttempts: 0,
        };

        // WebSocket事件监听
        client.on('shardDisconnect', (closeEvent, shardId) => {
            wsStateMonitor.disconnectedAt = Date.now();
            logTime(`WebSocket断开连接 [分片${shardId}] 代码: ${closeEvent.code} 原因: ${closeEvent.reason}`, true);
        });

        client.on('shardReconnecting', shardId => {
            wsStateMonitor.reconnectAttempts++;
            const downtime = wsStateMonitor.disconnectedAt
                ? Math.floor((Date.now() - wsStateMonitor.disconnectedAt) / 1000)
                : 0;

            logTime(
                `WebSocket正在重连 [分片${shardId}] 尝试次数: ${wsStateMonitor.reconnectAttempts} 已断开: ${downtime}秒`,
                true,
            );
        });

        client.on('shardResume', (shardId, replayedEvents) => {
            logTime(`WebSocket恢复连接 [分片${shardId}] 重放事件: ${replayedEvents}个`, true);
            wsStateMonitor.disconnectedAt = null;
            wsStateMonitor.reconnectAttempts = 0;
        });

        client.on('shardReady', shardId => {
            wsStateMonitor.lastPing = client.ws.ping;
            logTime(`WebSocket就绪 [分片${shardId}] 延迟: ${client.ws.ping}ms`);
        });

        // 心跳检测
        setInterval(() => {
            const currentPing = client.ws.ping;
            if (Math.abs(currentPing - wsStateMonitor.lastPing) > 100) {
                logTime(`WebSocket延迟变化显著: ${wsStateMonitor.lastPing}ms -> ${currentPing}ms`, true);
            }
            wsStateMonitor.lastPing = currentPing;
        }, 60000);

        // 保存监控状态到client
        client.wsStateMonitor = wsStateMonitor;

        // API监控
        client.rest
            .on('rateLimited', rateLimitData => {
                logTime(
                    `速率超限: • 路由: ${rateLimitData.route} - 方法: ${rateLimitData.method} - 剩余: ${
                        rateLimitData.timeToReset
                    }ms - 全局: ${rateLimitData.global ? '是' : '否'} - 限制: ${rateLimitData.limit || '未知'}`,
                    true,
                );
            })
            .on('response', (request, response) => {
                if (response.status === 429) {
                    logTime(
                        `API受限: • 路由: ${request.route} - 方法: ${request.method} - 状态: ${
                            response.status
                        } - 重试延迟: ${response.headers.get('retry-after')}ms`,
                        true,
                    );
                }
            });
    },
};
