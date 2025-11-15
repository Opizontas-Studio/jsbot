#!/bin/bash

#==============================================================================
# Discord Bot 启动和监控脚本
# 用途: 启动Bot或启动监控进程
# 用法: ./start.sh [--monitor]
#==============================================================================

# 配置变量
readonly APP_NAME="gatekeeper"
readonly SCRIPT_PATH="src/index.js"
readonly LOG_DIR="logs"
readonly ERROR_LOG="${LOG_DIR}/err.log"
readonly OUT_LOG="${LOG_DIR}/out.log"
readonly MAX_MEMORY="1G"
readonly CRON_RESTART="0 0 */7 * *"  # 每7天重启
readonly MEMORY_THRESHOLD=900000000   # 900MB
readonly MONITOR_INTERVAL=300         # 监控间隔（秒）

# 设置工作目录
cd "$(dirname "$0")" || exit 1

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ ERROR: $1" >&2
}

success() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1"
}

# 检查必需的依赖
check_dependencies() {
    local missing_deps=()

    if ! command -v node >/dev/null 2>&1; then
        missing_deps+=("node")
    fi

    if ! command -v pnpm >/dev/null 2>&1; then
        missing_deps+=("pnpm")
    fi

    if ! command -v pm2 >/dev/null 2>&1; then
        missing_deps+=("pm2")
    fi

    if [ ${#missing_deps[@]} -gt 0 ]; then
        error "缺少必需的依赖: ${missing_deps[*]}"
        error "请先安装: npm install -g pnpm pm2"
        exit 1
    fi
}

# 生成PM2配置文件
generate_pm2_config() {
    log "生成PM2配置文件..."
    cat > ecosystem.config.cjs << EOL
module.exports = {
  apps: [{
    name: '${APP_NAME}',
    script: '${SCRIPT_PATH}',
    watch: false,
    max_memory_restart: '${MAX_MEMORY}',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '${ERROR_LOG}',
    out_file: '${OUT_LOG}',
    time: true,
    cron_restart: '${CRON_RESTART}',
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,
    node_args: '--experimental-modules'
  }]
}
EOL
}

# 启动Bot
start_bot() {
    log "检查依赖..."
    check_dependencies

    # 创建日志目录
    mkdir -p "${LOG_DIR}"

    # 生成配置
    generate_pm2_config

    # 检查是否已在运行
    if pm2 list | grep -q "${APP_NAME}"; then
        log "发现已存在的${APP_NAME}进程，正在重启..."
        pm2 stop "${APP_NAME}" >/dev/null 2>&1
        pm2 delete "${APP_NAME}" >/dev/null 2>&1
    fi

    # 启动应用
    log "使用PM2启动Discord机器人..."
    if pm2 start ecosystem.config.cjs; then
        success "机器人启动成功"
    else
        error "机器人启动失败"
        exit 1
    fi

    # 保存PM2配置
    log "保存PM2配置..."
    pm2 save >/dev/null 2>&1

    # 设置开机自启（仅首次需要执行输出的命令）
    log "配置开机自启动..."
    pm2 startup >/dev/null 2>&1

    success "启动完成！"
    echo ""
    echo "常用命令:"
    echo "  查看日志: pm2 logs ${APP_NAME}"
    echo "  查看状态: pm2 status"
    echo "  重启Bot:  pm2 restart ${APP_NAME}"
    echo "  停止Bot:  pm2 stop ${APP_NAME}"
    echo "  启动监控: ./start.sh --monitor"
}

# 检查Bot状态并在需要时重启
check_and_restart() {
    if ! pm2 list | grep -q "${APP_NAME}.*online"; then
        log "检测到Bot未运行，尝试重启..."
        if pm2 restart "${APP_NAME}" >/dev/null 2>&1; then
            success "重启成功"
        else
            error "重启失败，尝试完全启动..."
            start_bot
        fi
    fi
}

# 检查内存使用
check_memory() {
    # 检查jq是否安装
    if ! command -v jq >/dev/null 2>&1; then
        return
    fi

    # 获取内存使用（通过应用名称查找）
    local memory_usage
    memory_usage=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"${APP_NAME}\") | .monit.memory" 2>/dev/null)

    if [ -n "$memory_usage" ] && [ "$memory_usage" != "null" ] && [ "$memory_usage" -gt "$MEMORY_THRESHOLD" ]; then
        local memory_mb=$((memory_usage / 1024 / 1024))
        log "内存使用过高 (${memory_mb}MB)，正在重启..."
        pm2 restart "${APP_NAME}" >/dev/null 2>&1
        success "重启完成"
    fi
}

# 监控模式
monitor_mode() {
    log "启动监控模式..."
    log "监控间隔: ${MONITOR_INTERVAL}秒"

    # 检查jq
    if ! command -v jq >/dev/null 2>&1; then
        log "警告: 未安装jq，内存监控将被禁用"
        log "安装命令: sudo apt install jq"
    fi

    # 捕获退出信号
    trap 'log "监控进程退出"; exit 0' SIGINT SIGTERM

    # 主循环
    while true; do
        check_and_restart
        check_memory
        sleep "${MONITOR_INTERVAL}"
    done
}

# 主函数
main() {
    case "${1:-}" in
        --monitor|-m)
            monitor_mode
            ;;
        --help|-h)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  (无参数)    启动Discord Bot"
            echo "  --monitor   启动监控模式，自动检查和重启"
            echo "  --help      显示此帮助信息"
            exit 0
            ;;
        "")
            start_bot
            ;;
        *)
            error "未知参数: $1"
            echo "使用 --help 查看帮助"
            exit 1
            ;;
    esac
}

main "$@"
