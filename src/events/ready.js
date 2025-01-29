import { Events, WebSocketShardStatus } from 'discord.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { createApplicationMessage } from '../services/roleApplication.js';
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

        // 修改分片状态处理函数
        const handleShardStatus = status => {
            let statusMessage = '';

            // 只用于日志记录
            switch (status) {
                case WebSocketShardStatus.Idle:
                    statusMessage = '分片状态: 空闲';
                    break;
                case WebSocketShardStatus.Connecting:
                    reconnectionCount++;
                    statusMessage = `分片状态: 正在连接 (重连次数: ${reconnectionCount})`;
                    break;
                case WebSocketShardStatus.Resuming:
                    statusMessage = '分片状态: 正在恢复会话';
                    break;
                case WebSocketShardStatus.Ready:
                    reconnectionCount = 0;
                    statusMessage = `分片状态: 已就绪 (延迟: ${client.ws.ping}ms)`;
                    break;
                default:
                    statusMessage = '分片状态: 未知状态';
                    break;
            }

            // 记录状态变化
            logTime(statusMessage);
        };

        // 事件监听器
        client.ws.on('close', () => {
            handleShardStatus(WebSocketShardStatus.Idle);
        });

        client.ws.on('reconnecting', () => {
            handleShardStatus(WebSocketShardStatus.Connecting);
        });

        client.ws.on('ready', () => {
            handleShardStatus(WebSocketShardStatus.Ready);
        });

        client.ws.on('resumed', () => {
            handleShardStatus(WebSocketShardStatus.Ready);
        });

        // 添加WebSocket状态检查
        client.on('debug', info => {
            if (info.includes('Session Limit Information')) {
                logTime('收到会话限制信息: ' + info);
            }
        });
    },
};
