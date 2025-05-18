import { ActivityType, Collection, Events } from 'discord.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { loadEvents } from '../index.js';
import { loadCommandFiles } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 添加配置文件加载
const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));

// 将初始化逻辑抽取为单独的函数
async function initializeClient(client) {
    // 初始化所有定时任务
    globalTaskScheduler.initialize(client);

    // 初始化WebSocket状态监控
    const wsStateMonitor = {
        lastPing: client.ws.ping,
        disconnectedAt: null,
        reconnectAttempts: 0,
    };

    // WebSocket事件监听
    client.on('shardDisconnect', (closeEvent, shardId) => {
        wsStateMonitor.disconnectedAt = Date.now();
        const isNormalClosure = closeEvent.code === 1000 || closeEvent.code === 1001;
        logTime(
            `WebSocket${isNormalClosure ? '正常关闭' : '断开连接'} [分片${shardId}] 代码: ${closeEvent.code}`,
            !isNormalClosure
        );
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
    wsStateMonitor.heartbeatInterval = setInterval(() => {
        const currentPing = client.ws.ping;
        if (Math.abs(currentPing - wsStateMonitor.lastPing) > 100) {
            logTime(`WebSocket延迟变化显著: ${wsStateMonitor.lastPing}ms -> ${currentPing}ms`, true);
        }
        wsStateMonitor.lastPing = currentPing;
    }, 60000);

    // 保存监控状态到client
    client.wsStateMonitor = wsStateMonitor;

    return wsStateMonitor;
}

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        logTime(`[系统启动] 已登录: ${client.user.tag}`);

        // 设置客户端状态
        client.user.setPresence({
            activities: [{
                name: 'Wait for your eternal presence.',
                type: ActivityType.Custom,
            }],
            status: 'idle',
        });

        const wsStateMonitor = await initializeClient(client);

        // API监控
        client.rest
            .on('rateLimited', rateLimitData => {
                logTime(
                    `[网关超限] 路由: ${rateLimitData.route} - 方法: ${rateLimitData.method} - 剩余: ${
                        rateLimitData.timeToReset
                    }ms - 全局: ${rateLimitData.global ? '是' : '否'} - 限制: ${rateLimitData.limit || '未知'}`,
                    true,
                );
            })
            .on('response', (request, response) => {
                if (response.status === 429) {
                    logTime(
                        `[API受限] 路由: ${request.route} - 方法: ${request.method} - 状态: ${
                            response.status
                        } - 重试延迟: ${response.headers.get('retry-after')}ms`
                    );
                }

                // token失效检测
                if (response.status === 401) {
                    logTime('[系统重启] Token已失效，尝试重新连接...', true);

                    // 清理现有的监听器和定时器
                    client.removeAllListeners();
                    clearInterval(wsStateMonitor.heartbeatInterval);

                    // 销毁客户端
                    client.destroy();

                    // 延迟3秒后重新登录和初始化
                    setTimeout(async () => {
                        try {
                            await client.login(config.token);
                            // 重新初始化所有功能
                            await initializeClient(client);

                            // 重新加载事件监听器
                            await loadEvents(client);

                            // 重新加载命令
                            const commandsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');
                            const commandModules = await loadCommandFiles(commandsPath);
                            client.commands = new Collection();

                            // 将Map转为数组进行遍历，每项包含[name, command]
                            for (const [name, command] of commandModules.entries()) {
                                if (command && command.data && command.data.name) {
                                    client.commands.set(command.data.name, command);
                                } else {
                                    logTime(`[系统重启] 警告: 在重连时加载命令 ${name || '未知命令'} 失败，缺少data.name属性。`, true);
                                }
                            }
                            logTime('[系统重启] Token重新连接并初始化成功，事件和命令已重新加载');
                        } catch (error) {
                            logTime(`[系统重启] Token重新连接或重新加载事件/命令失败: ${error.message}`, true);
                            console.error('详细错误:', error);
                        }
                    }, 3000);
                }
            });
    },
};
