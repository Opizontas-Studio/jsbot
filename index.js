const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { token } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
<<<<<<< Updated upstream

// 添加性能统计函数
const measureTime = () => {
    const start = process.hrtime();
    return () => {
        const [seconds, nanoseconds] = process.hrtime(start);
        return (seconds + nanoseconds / 1e9).toFixed(2);
    };
};

// 验证token
if (!token) {
    console.error('错误: 配置文件中缺少token');
    process.exit(1);
}
=======
const { measureTime, logTime } = require('./utils/common');
const { loadCommandFiles } = require('./utils/commandLoader');
>>>>>>> Stashed changes

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

// 加载命令
const commands = loadCommandFiles();
for (const [name, command] of commands) {
    client.commands.set(name, command);
}

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
        console.error(`未找到命令 ${interaction.commandName}`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`执行命令 ${interaction.commandName} 时出错:`, error);
        const message = '执行此命令时出现错误。';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: message, ephemeral: true });
        } else {
            await interaction.reply({ content: message, ephemeral: true });
        }
    }
});

// 设置定时分析任务
const scheduleAnalysis = () => {
    const INTERVAL = 12 * 60 * 60 * 1000; // 12小时的毫秒数
    
    // 计算下一次执行的时间
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(now.getHours() + (now.getHours() < 12 ? 12 - now.getHours() : 24 - now.getHours()));
    nextRun.setMinutes(0);
    nextRun.setSeconds(0);
    nextRun.setMilliseconds(0);
    
    const timeUntilNextRun = nextRun.getTime() - now.getTime();
    
    // 设置首次延迟执行
    setTimeout(() => {
        // 执行分析
        const { analyzeThreads } = require('./utils/threadAnalyzer');
        const config = require('./config.json');
        
        analyzeThreads(client, config)
            .then(() => console.log('定时分析任务执行完成'))
            .catch(error => console.error('定时分析任务执行失败:', error));
        
        // 设置后续定期执行
        setInterval(() => {
            analyzeThreads(client, config)
                .then(() => console.log('定时分析任务执行完成'))
                .catch(error => console.error('定时分析任务执行失败:', error));
        }, INTERVAL);
        
    }, timeUntilNextRun);
    
    console.log(`首次定时分析将在 ${nextRun.toLocaleString()} 执行`);
};

// 在 ClientReady 事件中启动定时任务
client.once(Events.ClientReady, async c => {
    console.log(`准备就绪! 已登录为 ${c.user.tag}`);
    scheduleAnalysis();
});

process.on('unhandledRejection', error => {
    console.error('未处理的Promise拒绝:', error);
});

// 在 login 之前添加计时
console.log('正在登录...');
const loginTimer = measureTime();

client.login(token)
    .then(() => {
        console.log(`登录完成，用时: ${loginTimer()}秒`);
    })
    .catch(error => {
        console.error('登录失败:', error);
        process.exit(1);
    });