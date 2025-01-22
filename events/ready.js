import { Events } from 'discord.js';
import { logTime } from '../utils/logger.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { createApplicationMessage } from '../services/roleApplication.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';

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

	    // 初始化分片状态
	    globalRequestQueue.setShardStatus('ready');

	    // 分片状态处理函数
	    const handleShardStatus = (status, event = null) => {
	        // 清除之前的超时
	        if (reconnectionTimeout) {
	            clearTimeout(reconnectionTimeout);
	            reconnectionTimeout = null;
	        }

	        let message = '';
	        let details = '';

	        const CLOSE_CODES = {
	            1000: '正常关闭',
	            1001: '服务器关闭',
	            1006: '异常关闭',
	            4000: '未知错误',
	            4004: '认证失败',
	            4011: '分片无效',
	        };

	        // 根据状态设置消息
	        switch (status) {
	            case 'disconnected':
	                if (event) {
	                    const reason = CLOSE_CODES[event.code] || '未知原因';
	                    message = `连接断开 (代码: ${event.code} - ${reason})`;
	                    details = `是否清理: ${event.wasClean}`;
	                }
				else {
	                    message = '连接断开';
	                }
	                break;
	            case 'reconnecting':
	                reconnectionCount++;
	                lastReconnectionTime = Date.now();

	                // 设置重连超时检查
	                reconnectionTimeout = setTimeout(() => {
	                    if (client.ws.status === 6) { // WebSocket.CONNECTING
	                        logTime('重连超时，强制重置连接状态', true);
	                        handleShardStatus('ready');
	                        client.destroy().then(() => client.login(config.token));
	                    }
	                }, 30000); // 30秒超时

	                message = '正在重新连接...';
	                details = `重连次数: ${reconnectionCount}, 时间: ${new Date().toISOString()}`;
	                break;
	            case 'resumed':
	                reconnectionCount = 0;
	                lastReconnectionTime = null;
	                message = '已恢复连接';
	                details = `恢复时间: ${new Date().toISOString()}, 重连延迟: ${client.ws.ping}ms`;
	                break;
	            case 'error':
	                message = event ? `发生错误: ${event.message}` : '发生错误';
	                if (event) {
	                    details = `错误堆栈: ${event.stack || '无'}, 错误代码: ${event.code || '无'}`;
	                }
	                break;
	            case 'ready':
	                reconnectionCount = 0;
	                lastReconnectionTime = null;
	                message = '已就绪';
	                details = `WebSocket延迟: ${client.ws.ping}ms`;
	                break;
	        }

	        // 记录状态和详细信息
	        logTime(`${message}${details ? ` | ${details}` : ''}`, status === 'error');

	        // 设置请求队列状态
	        globalRequestQueue.setShardStatus(status);
	    };

	    // 事件监听
	    client.on('shardDisconnect', (event) => {
	        if (event.code === 1000 || event.code === 1001) return;
	        handleShardStatus('disconnected', event);
	    });

	    client.on('shardReconnecting', () => {
	        handleShardStatus('reconnecting');
	    });

	    client.on('shardResumed', () => {
	        handleShardStatus('resumed');
	    });

	    client.on('shardReady', () => {
	        handleShardStatus('ready');
	    });

	    // 添加WebSocket状态检查
	    client.on('debug', (info) => {
	        if (info.includes('Session Limit Information')) {
	            logTime('收到会话限制信息: ' + info);
	        }
	        if (info.includes('[WS => Shard 0] Heartbeat acknowledged')) {
	            // 心跳正常，说明连接是活跃的
	            if (client.ws.status === 6) { // 如果仍在CONNECTING状态
	                handleShardStatus('ready');
	            }
	        }
	    });
	},
};