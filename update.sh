#!/bin/bash

# 设置工作目录
cd "$(dirname "$0")"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 拉取最新代码（如果使用git）
if [ -d ".git" ]; then
    log "拉取最新代码..."
    git pull
fi

# 安装依赖（如果package.json有更新）
if [ -f "package.json" ]; then
    log "安装依赖..."
    pnpm install
fi

# 停止现有进程
log "停止Discord机器人..."
pm2 stop discord-bot

# 启动服务
log "启动Discord机器人..."
pm2 start ecosystem.config.cjs

# 保存PM2配置
log "保存PM2配置..."
pm2 save

log "更新完成。使用 'pm2 logs discord-bot' 查看日志"
