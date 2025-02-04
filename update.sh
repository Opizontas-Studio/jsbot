#!/bin/bash

# 设置工作目录
cd "$(dirname "$0")"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 拉取最新代码（如果使用git）
if [ -d ".git" ]; then
    log "Pulling latest changes..."
    git pull
fi

# 安装依赖（如果package.json有更新）
if [ -f "package.json" ]; then
    log "Installing dependencies..."
    pnpm install
fi

# 停止现有进程
log "Stopping Discord bot..."
pm2 stop discord-bot

# 重新构建
log "Rebuilding project..."
pnpm run build

# 重启服务
log "Starting Discord bot..."
pm2 start ecosystem.config.cjs

# 保存PM2配置
log "Saving PM2 configuration..."
pm2 save

log "Update complete. Use 'pm2 logs discord-bot' to view logs" 