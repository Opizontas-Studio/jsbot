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
        globalRequestQueue.setShardStatus('ready');
        
        // 分片状态变化
        const handleShardStatus = (status, event = null) => {
            let message = '';
            let details = '';
            
            const CLOSE_CODES = {
                1000: '正常关闭',
                1001: '服务器关闭',
                1006: '异常关闭',
                4000: '未知错误',
                4004: '认证失败',
                4011: '分片无效'
            };
            
            // 根据状态设置消息和详细信息
            switch (status) {
                case 'disconnected':
                    if (event) {
                        const reason = CLOSE_CODES[event.code] || '未知原因';
                        message = `连接断开 (代码: ${event.code} - ${reason})`;
                        details = `是否清理: ${event.wasClean}`;
                    } else {
                        message = '连接断开';
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
            
            logTime(message, status === 'error');
            if (details) {
                logTime(details, status === 'error');
            }
            
            // 记录当前的连接统计
            const shard = client.ws.shards.get(0);
            const reconnectCount = shard ? shard.sequence || 0 : 0;
            logTime(`连接统计 - 重连次数: ${reconnectCount}, WebSocket延迟: ${client.ws.ping}ms${details ? ', ' + details : ''}`);
            
            globalRequestQueue.setShardStatus(status);
        };

        // 事件监听
        client.on('shardDisconnect', (event) => handleShardStatus('disconnected', event));
        client.on('shardReconnecting', () => handleShardStatus('reconnecting'));
        client.on('shardResumed', () => handleShardStatus('resumed'));
        client.on('shardError', (error) => handleShardStatus('error', error));
        client.on('shardReady', () => handleShardStatus('ready'));

        // 添加WebSocket状态监听
        client.ws.on('ready', () => {
            const shard = client.ws.shards.get(0);
            const reconnectCount = shard ? shard.sequence || 0 : 0;
            const sessionId = shard?.sessionId || '无';
            
            logTime('WebSocket连接就绪');
            logTime(`WebSocket状态 - 重连次数: ${reconnectCount}, 延迟: ${client.ws.ping}ms, 会话ID: ${sessionId}`);
            
            if (globalRequestQueue.shardStatus.get(0) !== 'ready') {
                globalRequestQueue.setShardStatus('ready');
            }
        });
    },
}; 