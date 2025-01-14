const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

// 检查必要文件
const requiredFiles = ['config.json', 'index.js', 'deploy-commands.js'];
for (const file of requiredFiles) {
    if (!existsSync(join(__dirname, file))) {
        console.error(`错误: 找不到必要文件 ${file}`);
        process.exit(1);
    }
}

// 部署命令
console.log('正在部署命令...');
const deploy = spawn('node', ['deploy-commands.js']);

deploy.stdout.on('data', data => console.log(data.toString()));
deploy.stderr.on('data', data => console.error(data.toString()));

deploy.on('close', code => {
    if (code !== 0) {
        console.error('命令部署失败');
        process.exit(1);
    }

    console.log('命令部署完成，正在启动机器人...');

    // 启动机器人
    const bot = spawn('node', ['index.js'], {
        stdio: 'inherit'
    });

    bot.on('close', code => {
        console.log(`机器人进程已退出，退出码: ${code}`);
    });
});