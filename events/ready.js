import { Events } from 'discord.js';
import { logTime } from '../utils/logger.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { createApplicationMessage } from '../utils/roleApplication.js';
import { globalTaskScheduler } from '../tasks/scheduler.js';

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
        globalRequestQueue.setShardStatus(0, 'ready');
        
        // 分片状态变化
        const handleShardStatus = (status, id, event = null) => {
            let message = '';
            
            switch (status) {
                case 'disconnected':
                    if (event) {
                        message = `分片断开连接 (代码: ${event.code})`;
                    } else {
                        message = '分片断开连接';
                    }
                    break;
                case 'reconnecting':
                    message = '正在重新连接...';
                    break;
                case 'resumed':
                    message = '已恢复连接';
                    break;
                case 'error':
                    message = event ? `发生错误: ${event.message}` : '发生错误';
                    break;
                case 'ready':
                    message = '已就绪';
                    break;
            }
            
            logTime(`分片 ${id} ${message}`, status === 'error');
            
            // 检查WebSocket连接状态
            const wsStatus = client.ws.status;
            if (status === 'reconnecting' && wsStatus === 0) {
                logTime('WebSocket连接正常，忽略重连状态');
                return;
            }
            
            globalRequestQueue.setShardStatus(id, status);
        };

        // 事件监听
        client.on('shardDisconnect', (event, id) => handleShardStatus('disconnected', id, event));
        client.on('shardReconnecting', (id) => handleShardStatus('reconnecting', id));
        client.on('shardResumed', (id) => handleShardStatus('resumed', id));
        client.on('shardError', (error, id) => handleShardStatus('error', id, error));
        client.on('shardReady', (id) => handleShardStatus('ready', id));

        // 添加WebSocket状态监听
        client.ws.on('ready', () => {
            logTime('WebSocket连接就绪');
            globalRequestQueue.setShardStatus(0, 'ready');
        });
    },
}; 