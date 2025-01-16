const { Events } = require('discord.js');
const { logTime } = require('../utils/helper');
const { analyzeThreads } = require('../utils/analyzers');
const { globalRequestQueue, globalRateLimiter } = require('../utils/concurrency');
const { createApplicationMessage } = require('./roleApplication');

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
                    logTime(`服务器 ${guildId} 的定时分析完成`);
                }

                // 只在启用自动清理时执行清理
                if (guildConfig.automation?.cleanup?.enabled) {
                    logTime(`开始执行服务器 ${guildId} 的自动清理...`);
                    await analyzeThreads(client, guildConfig, guildId, {
                        clean: true,
                        threshold: guildConfig.automation.cleanup.threshold || 960
                    });
                    logTime(`服务器 ${guildId} 的自动清理完成`);
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
        
        // 输出下次执行时间和任务类型
        const taskTypes = [];
        if (guildConfig.automation?.analysis) {
            taskTypes.push('分析');
        }
        if (guildConfig.automation?.cleanup?.enabled) {
            taskTypes.push('清理');
        }
        if (taskTypes.length > 0) {
            logTime(`服务器 ${guildId} 下次${taskTypes.join('和')}时间: ${nextRun.toLocaleTimeString()}`);
        }
    };

    // 为每个服务器设置定时任务
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        scheduleNextRun(guildId, guildConfig);
    }
};

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        logTime(`已登录: ${client.user.tag}`);
        scheduleAnalysis(client);
        
        // 初始化身份组申请消息
        await createApplicationMessage(client);
        
        // 监听分片断开连接事件
        client.on('shardDisconnect', (event, id) => {
            logTime(`分片 ${id} 断开连接: ${event.reason}`, true);
        });
        
        // 监听分片重新连接事件
        client.on('shardReconnecting', (id) => {
            logTime(`分片 ${id} 正在重新连接...`);
        });
        
        // 监听分片恢复连接事件
        client.on('shardResumed', (id) => {
            logTime(`分片 ${id} 已恢复连接。`);
        });
    },
}; 