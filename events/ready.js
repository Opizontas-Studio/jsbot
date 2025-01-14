const { Events } = require('discord.js');
const { logTime } = require('../utils/common');
const { analyzeThreads } = require('../utils/threadAnalyzer');
const config = require('../config.json');

// 定时分析任务设置
const scheduleAnalysis = (client) => {
    const INTERVAL = 12 * 60 * 60 * 1000; // 12小时
    
    // 设置每天 9点 和 21点 执行
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(now.getHours() < 9 ? 9 : 
                     now.getHours() < 21 ? 21 : 33, 0, 0, 0);
    if (nextRun.getHours() === 33) {
        nextRun.setHours(9);
        nextRun.setDate(nextRun.getDate() + 1);
    }
    
    const timeUntilNextRun = nextRun - now;
    
    // 设置定时执行
    const runAnalysis = () => {
        analyzeThreads(client, config)
            .then(() => logTime('定时分析完成'))
            .catch(error => logTime('定时分析失败: ' + error, true));
    };

    // 设置首次执行和定期执行
    setTimeout(() => {
        runAnalysis();
        setInterval(runAnalysis, INTERVAL);
    }, timeUntilNextRun);
    
    logTime(`首次定时分析将在 ${nextRun.toLocaleString()} 执行`);
};

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        logTime(`准备就绪! 已登录为 ${client.user.tag}`);
        scheduleAnalysis(client);
    },
}; 