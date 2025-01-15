const { Events } = require('discord.js');
const { logTime } = require('../utils/common');
const { analyzeThreads } = require('../utils/threadAnalyzer');

/**
 * 设置定时分析任务
 * 在每天9点和21点执行论坛主题分析
 * @param {Client} client - Discord.js客户端实例
 */
const scheduleAnalysis = (client) => {
    // 为每个服务器设置定时任务
    for (const [guildId, guildConfig] of client.guildManager.guilds) {
        const { times } = guildConfig.analysisSchedule;
        
        // 计算下次执行时间
        const now = new Date();
        const nextRun = new Date(now);
        const nextTime = times.find(time => time > now.getHours()) || times[0];
        
        nextRun.setHours(nextTime, 0, 0, 0);
        if (nextTime <= now.getHours()) {
            nextRun.setDate(nextRun.getDate() + 1);
        }
        
        const timeUntilNextRun = nextRun - now;
        
        // 设置定时执行
        const runAnalysis = () => {
            analyzeThreads(client, guildConfig, guildId)
                .then(() => logTime(`服务器 ${guildId} 定时分析完成`))
                .catch(error => logTime(`服务器 ${guildId} 定时分析失败: ${error}`, true));
        };

        // 设置首次执行和定期执行
        setTimeout(() => {
            runAnalysis();
            setInterval(runAnalysis, 24 * 60 * 60 * 1000 / times.length);
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