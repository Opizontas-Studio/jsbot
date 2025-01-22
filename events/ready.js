import { Events, WebSocketShardStatus } from 'discord.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { createApplicationMessage } from '../services/roleApplication.js';
import { globalRequestQueue } from '../utils/concurrency.js';
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

	    // 初始化分片状态
	    globalRequestQueue.setShardStatus('ready');

	    // 修改分片状态处理函数
	    const handleShardStatus = (status) => {
	        // 清除之前的超时
	        if (reconnectionTimeout) {
	            clearTimeout(reconnectionTimeout);
	            reconnectionTimeout = null;
	        }

	        let statusMessage = '';

	        // 根据WebSocketShardStatus枚举设置消息
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

	        // 状态信息
	        logTime(statusMessage);

	        // 设置请求队列状态
	        globalRequestQueue.setShardStatus(status);
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
	    client.on('debug', (info) => {
	        if (info.includes('Session Limit Information')) {
	            logTime('收到会话限制信息: ' + info);
	        }
	    });
  },
};