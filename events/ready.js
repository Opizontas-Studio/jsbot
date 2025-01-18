import { Events } from 'discord.js';
import { logTime } from '../utils/logger.js';
import { analyzeThreads } from '../utils/analyzers.js';
import { globalRequestQueue, globalRateLimiter } from '../utils/concurrency.js';
import { createApplicationMessage } from '../utils/roleApplication.js';

/**
 * 执行定时任务
 * @param {Client} client - Discord客户端实例
 * @param {Object} guildConfig - 服务器配置
 * @param {string} guildId - 服务器ID
 */
const runScheduledTasks = async (client, guildConfig, guildId) => {
    try {
        // 使用请求队列和速率限制
        await globalRequestQueue.add(async () => {
            await globalRateLimiter.withRateLimit(async () => {
                // 只在启用自动分析时执行分析任务
                if (guildConfig.automation?.analysis) {
                    await analyzeThreads(client, guildConfig, guildId);
                }

                // 只在启用自动清理时执行清理
                if (guildConfig.automation?.cleanup?.enabled) {
                    await analyzeThreads(client, guildConfig, guildId, {
                        clean: true,
                        threshold: guildConfig.automation.cleanup.threshold || 960
                    });
                }
            });
        }, 0); // 使用最低优先级
    } catch (error) {
        logTime(`服务器 ${guildId} 的定时任务执行失败: ${error.message}`, true);
    }
};

/**
 * 设置定时分析任务
 * @param {Client} client - Discord.js客户端实例
 */
const scheduleAnalysis = (client) => {
    // 存储每个服务器的定时器ID
    const timers = new Map();

    const scheduleNextRun = (guildId, guildConfig) => {
        // 清除已存在的定时器
        if (timers.has(guildId)) {
            clearTimeout(timers.get(guildId));
        }

        // 计算下次执行时间
        const now = new Date();
        const nextRun = new Date(now);
        
        if (nextRun.getMinutes() >= 30) {
            nextRun.setHours(nextRun.getHours() + 1);
            nextRun.setMinutes(0);
        } else {
            nextRun.setMinutes(30);
        }
        nextRun.setSeconds(0);
        nextRun.setMilliseconds(0);
        
        const timeUntilNextRun = nextRun - now;
        
        // 设置新的定时器
        const timer = setTimeout(async () => {
            try {
                await runScheduledTasks(client, guildConfig, guildId);
            } catch (error) {
                logTime(`服务器 ${guildId} 定时任务执行出错: ${error}`, true);
            } finally {
                // 无论成功失败，都重新调度下一次执行
                scheduleNextRun(guildId, guildConfig);
            }
        }, timeUntilNextRun);

        // 存储定时器ID
        timers.set(guildId, timer);
    };

    // 为每个服务器设置定时任务
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        scheduleNextRun(guildId, guildConfig);
    }
};

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        logTime(`已登录: ${client.user.tag}`);
        scheduleAnalysis(client);
        
        // 初始化身份组申请消息
        await createApplicationMessage(client);
        
        // 初始化分片状态
        globalRequestQueue.setShardStatus(0, 'ready');
        
        // 分片状态变化
        const handleShardStatus = (status, id, reason = '') => {
            const statusMessages = {
                'disconnected': `分片断开连接: ${reason}`,
                'reconnecting': '正在重新连接...',
                'resumed': '已恢复连接',
                'error': `发生错误: ${reason}`,
                'ready': '已就绪'
            };
            
            logTime(`分片 ${id} ${statusMessages[status]}`, status === 'error');
            
            // 检查WebSocket连接状态
            const wsStatus = client.ws.status;
            if (status === 'reconnecting' && wsStatus === 0) {
                logTime('WebSocket连接正常，忽略重连状态');
                return;
            }
            
            globalRequestQueue.setShardStatus(id, status);
        };

        // 事件监听
        client.on('shardDisconnect', (event, id) => handleShardStatus('disconnected', id, event.reason));
        client.on('shardReconnecting', (id) => handleShardStatus('reconnecting', id));
        client.on('shardResumed', (id) => handleShardStatus('resumed', id));
        client.on('shardError', (error, id) => handleShardStatus('error', id, error.message));
        client.on('shardReady', (id) => handleShardStatus('ready', id));

        // 添加WebSocket状态监听
        client.ws.on('ready', () => {
            logTime('WebSocket连接就绪');
            globalRequestQueue.setShardStatus(0, 'ready');
        });
    },
}; 