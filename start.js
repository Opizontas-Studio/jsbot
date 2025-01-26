import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 检查必要的命令是否存在
async function checkDependencies() {
    return new Promise((resolve, reject) => {
        const tsc = spawn('npx', ['tsc', '--version'], {
            stdio: 'ignore',
            shell: true,
        });

        tsc.on('close', code => {
            if (code !== 0) {
                reject(new Error('TypeScript 编译器(tsc)未找到，请先运行: npm install'));
            } else {
                resolve();
            }
        });
    });
}

// 编译 TypeScript
async function buildProject() {
    return new Promise((resolve, reject) => {
        const build = spawn('npx', ['rimraf', 'dist/', '&&', 'tsc', '-p', 'tsconfig.json'], {
            stdio: 'inherit',
            shell: true,
        });

        build.on('close', code => {
            // 检查编译后的文件是否存在
            if (!existsSync(join(__dirname, 'dist', 'index.js'))) {
                reject(new Error('编译失败：未生成 dist/index.js 文件'));
                return;
            }

            if (code === 0 || code === 1) {
                resolve();
            } else {
                reject(new Error(`构建失败，退出代码 ${code}`));
            }
        });

        build.on('error', reject);
    });
}

// 计算下次重启时间
function getNextRestartTime() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 6);
    return next;
}

// 格式化时间差
function formatTimeDiff(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}小时${minutes % 60}分钟${seconds % 60}秒`;
}

// 优雅关闭处理
async function gracefulShutdown(bot, restartTimer, maxWaitTime = 60000) {
    let forceKill = false;

    // 创建一个Promise，在超时后resolve
    const timeoutPromise = new Promise(resolve => {
        setTimeout(() => {
            forceKill = true;
            resolve();
        }, maxWaitTime);
    });

    // 创建一个Promise，在进程关闭后resolve
    const closePromise = new Promise(resolve => {
        bot.once('close', code => {
            resolve(code);
        });
    });

    // 清除重启定时器
    if (restartTimer) {
        clearTimeout(restartTimer);
    }

    // 发送SIGINT信号
    bot.kill('SIGINT');

    // 等待进程关闭或超时
    const code = await Promise.race([closePromise, timeoutPromise]);

    // 如果超时，强制结束进程
    if (forceKill) {
        console.log('\n等待超时，强制结束进程...');
        bot.kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return code;
}

// 启动 Bot
async function startBot(options = { isRestart: false, skipBuild: false }) {
    try {
        // 只在手动启动时编译
        if (!options.skipBuild) {
            console.log('正在检查依赖...');
            await checkDependencies();

            console.log('正在编译项目...');
            await buildProject();
            console.log('编译完成，启动 Bot 进程...');
        } else {
            // 即使跳过编译，也要确保dist目录存在
            if (!existsSync(join(__dirname, 'dist', 'index.js'))) {
                console.error('错误：dist/index.js 不存在，需要重新编译');
                console.log('正在检查依赖...');
                await checkDependencies();
                console.log('正在编译项目...');
                await buildProject();
                console.log('编译完成，启动 Bot 进程...');
            } else {
                console.log('跳过编译，直接重启 Bot 进程...');
            }
        }

        // 启动 Bot 进程
        const bot = spawn('node', ['dist/index.js'], {
            stdio: 'inherit',
            shell: true,
        });

        // 设置下次重启时间
        const nextRestartTime = getNextRestartTime();
        const restartTimeout = nextRestartTime.getTime() - Date.now();

        console.log(`下次预定重启时间: ${nextRestartTime.toLocaleString()}`);
        console.log(`距离下次重启还有: ${formatTimeDiff(restartTimeout)}`);

        // 设置定时重启
        const restartTimer = setTimeout(async () => {
            console.log('\n到达预定重启时间，正在重启 Bot...');
            await gracefulShutdown(bot, null);
            // 定时重启时跳过编译
            startBot({ isRestart: true, skipBuild: true });
        }, restartTimeout);

        let shutdownInProgress = false;

        // 处理 SIGINT (Ctrl+C)
        process.on('SIGINT', async () => {
            if (shutdownInProgress) {
                console.log('\n再次收到关闭信号，强制结束进程...');
                bot.kill('SIGKILL');
                process.exit(1);
            }

            shutdownInProgress = true;
            console.log('\n收到关闭信号，正在关闭 Bot...');
            const code = await gracefulShutdown(bot, restartTimer);

            if (code === 0 || code === null) {
                process.exit(0);
            } else {
                process.exit(1);
            }
        });

        // 处理 SIGTERM
        process.on('SIGTERM', async () => {
            if (shutdownInProgress) return;

            shutdownInProgress = true;
            console.log('\n收到终止信号，正在关闭 Bot...');
            const code = await gracefulShutdown(bot, restartTimer);

            if (code === 0 || code === null) {
                process.exit(0);
            } else {
                process.exit(1);
            }
        });

        // 监听子进程意外退出
        bot.on('close', code => {
            clearTimeout(restartTimer);
            if (!shutdownInProgress && code !== 0 && code !== null) {
                console.error(`Bot 进程意外退出，退出代码: ${code}`);
                console.log('5秒后尝试重启...');
                // 意外退出时也跳过编译
                setTimeout(() => startBot({ isRestart: true, skipBuild: true }), 5000);
            }
        });

        // 处理子进程错误
        bot.on('error', error => {
            console.error('Bot 进程发生错误:', error);
            clearTimeout(restartTimer);
        });
    } catch (error) {
        console.error('启动失败:', error.message);
        if (error.message.includes('TypeScript 编译器')) process.exit(1);
    }
}

// 启动程序
startBot({ isRestart: false, skipBuild: false }).catch(error => {
    console.error('启动失败:', error);
    process.exit(1);
});
