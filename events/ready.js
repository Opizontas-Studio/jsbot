const { Events } = require('discord.js');
const { logTime } = require('../utils/helper');
const { analyzeThreads } = require('../utils/analyzers');

/**
 * 设置定时分析任务
 * 每半小时执行一次论坛子区分析
 * @param {Client} client - Discord.js客户端实例
 */
const scheduleAnalysis = (client) => {
    // 为每个服务器设置定时任务
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        // 计算下次执行时间
        const now = new Date();
        const nextRun = new Date(now);
        
        // 设置为下一个半小时
        if (nextRun.getMinutes() >= 30) {
            nextRun.setHours(nextRun.getHours() + 1);
            nextRun.setMinutes(0);
        } else {
            nextRun.setMinutes(30);
        }
        nextRun.setSeconds(0);
        nextRun.setMilliseconds(0);
        
        const timeUntilNextRun = nextRun - now;
        
        // 设置定时执行
        const runAnalysis = () => {
            analyzeThreads(client, guildConfig, guildId)
                .then(() => logTime(`服务器 ${guildId} 定时分析完成`))
                .catch(error => logTime(`服务器 ${guildId} 定时分析失败: ${error}`, true));
        };

        // 设置首次执行和定期执行（每30分钟）
        setTimeout(() => {
            runAnalysis();
            setInterval(runAnalysis, 30 * 60 * 1000);
        }, timeUntilNextRun);
        
        logTime(`服务器 ${guildId} 下次分析: ${nextRun.toLocaleTimeString()}`);
    }
};

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        logTime(`已登录: ${client.user.tag}`);
        scheduleAnalysis(client);
        
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