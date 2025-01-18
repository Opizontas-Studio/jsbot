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
            let details = '';
            
            switch (status) {
                case 'disconnected':
                    if (event) {
                        message = `分片断开连接 (代码: ${event.code})`;
                        details = `断开原因: ${event.reason || '未知'}, 是否清理: ${event.wasClean}`;
                    } else {
                        message = '分片断开连接';
                    }
                    break;
                case 'reconnecting':
                    message = '正在重新连接...';
                    details = `重连时间: ${new Date().toISOString()}`;
                    break;
                case 'resumed':
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
                    message = '已就绪';
                    details = `WebSocket延迟: ${client.ws.ping}ms`;
                    break;
            }
            
            logTime(`分片 ${id} ${message}`, status === 'error');
            if (details) {
                logTime(`分片 ${id} 详细信息: ${details}`, status === 'error');
            }
            
            // 记录当前的连接统计
            logTime(`连接统计 - 总重连次数: ${client.ws.reconnects}, 当前延迟: ${client.ws.ping}ms`);
            
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
            logTime(`WebSocket状态 - 延迟: ${client.ws.ping}ms, 会话ID: ${client.ws.shards.get(0)?.sessionId || '无'}`);
            
            if (globalRequestQueue.shardStatus.get(0) !== 'ready') {
                globalRequestQueue.setShardStatus(0, 'ready');
            }
        });
    },
}; 