#!/bin/bash

# 设置工作目录
cd "$(dirname "$0")"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 构建TypeScript
build_typescript() {
    log "Building TypeScript files..."
    if pnpm run build; then
        log "TypeScript build completed successfully"
        return 0
    else
        log "TypeScript build failed"
        return 1
    fi
}

# PM2配置文件
cat > ecosystem.config.cjs << EOL
module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'dist/index.js',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    time: true,
    // 每12小时重启一次
    cron_restart: '0 */12 * * *',
    // 优雅关闭
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,
    node_args: '--experimental-modules'
  }]
}
EOL

# 创建日志目录
mkdir -p logs

# 构建项目
if ! build_typescript; then
    log "Build failed, exiting..."
    exit 1
fi

# 检查PM2是否已经在运行这个应用
if pm2 list | grep -q "discord-bot"; then
    log "Stopping existing discord-bot process..."
    pm2 stop discord-bot
    pm2 delete discord-bot
fi

# 启动应用
log "Starting Discord Bot with PM2..."
pm2 start ecosystem.config.cjs

# 保存PM2配置
log "Saving PM2 configuration..."
pm2 save

# 设置开机自启
log "Setting up startup script..."
pm2 startup

log "Bot startup complete. Use 'pm2 logs discord-bot' to view logs" 
