#!/bin/bash

# 设置工作目录
cd "$(dirname "$0")"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# 检查bot状态并在需要时重启
check_and_restart() {
    if ! pm2 list | grep -q "discord-bot.*online"; then
        log "Bot is not running properly, attempting restart..."
        ./start.sh
    fi
}

# 检查内存使用
check_memory() {
    local memory_usage=$(pm2 jlist | jq '.[0].monit.memory')
    if [ ! -z "$memory_usage" ] && [ $memory_usage -gt 900000000 ]; then  # 900MB
        log "Memory usage too high ($memory_usage bytes), restarting..."
        pm2 restart discord-bot
    fi
}

# 主循环
while true; do
    check_and_restart
    check_memory
    sleep 300  # 每5分钟检查一次
done
