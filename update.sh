#!/bin/bash

#==============================================================================
# Discord Bot 更新脚本
# 用途: 拉取最新代码、安装依赖并重载Bot（零停机）
# 用法: ./update.sh
#==============================================================================

# 配置变量（与start.sh保持一致）
readonly APP_NAME="gatekeeper"

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

# 检查PM2是否安装
check_pm2() {
    if ! command -v pm2 >/dev/null 2>&1; then
        error "PM2未安装，请先运行: npm install -g pm2"
        exit 1
    fi
}

# 检查Bot是否在运行
check_bot_running() {
    if ! pm2 list | grep -q "${APP_NAME}"; then
        error "Bot未运行，请先执行 ./start.sh 启动"
        exit 1
    fi
}

# 备份当前版本信息
backup_version() {
    if [ -d ".git" ]; then
        local current_commit
        current_commit=$(git rev-parse --short HEAD 2>/dev/null)
        if [ -n "$current_commit" ]; then
            log "当前版本: ${current_commit}"
            echo "${current_commit}" > .last_version
        fi
    fi
}

# 拉取最新代码
pull_code() {
    if [ -d ".git" ]; then
        log "拉取最新代码..."

        # 检查是否有未提交的更改
        if ! git diff-index --quiet HEAD -- 2>/dev/null; then
            log "警告: 检测到未提交的更改"
        fi

        # 拉取代码
        if git pull; then
            success "代码更新成功"

            # 显示更新内容
            if [ -f ".last_version" ]; then
                local last_version
                last_version=$(cat .last_version)
                log "更新内容:"
                git log --oneline "${last_version}..HEAD" | head -5
            fi
        else
            error "代码拉取失败"
            return 1
        fi
    else
        log "非Git仓库，跳过代码拉取"
    fi
}

# 安装依赖
install_dependencies() {
    if [ -f "package.json" ]; then
        log "检查并安装依赖..."

        if ! command -v pnpm >/dev/null 2>&1; then
            error "pnpm未安装，请先运行: npm install -g pnpm"
            exit 1
        fi

        if pnpm install; then
            success "依赖安装完成"
        else
            error "依赖安装失败"
            return 1
        fi
    fi
}

# 重载Bot（零停机更新）
reload_bot() {
    log "重载Discord机器人..."

    # 使用reload而不是restart实现零停机
    if pm2 reload "${APP_NAME}"; then
        success "机器人重载成功"
    else
        log "reload失败，尝试restart..."
        if pm2 restart "${APP_NAME}"; then
            success "机器人重启成功"
        else
            error "机器人重启失败"
            return 1
        fi
    fi

    # 保存PM2配置
    pm2 save >/dev/null 2>&1
}

# 显示状态
show_status() {
    echo ""
    log "当前状态:"
    pm2 list | grep -E "(${APP_NAME}|App name)" || pm2 status
    echo ""
    echo "查看日志: pm2 logs ${APP_NAME} --lines 50"
}

# 主函数
main() {
    log "开始更新Discord Bot..."
    echo ""

    # 检查环境
    check_pm2
    check_bot_running

    # 备份版本
    backup_version

    # 更新流程
    if ! pull_code; then
        error "更新失败：代码拉取错误"
        exit 1
    fi

    if ! install_dependencies; then
        error "更新失败：依赖安装错误"
        exit 1
    fi

    if ! reload_bot; then
        error "更新失败：Bot重载错误"
        exit 1
    fi

    # 显示状态
    show_status

    success "更新完成！"
}

# 捕获错误
set -e
trap 'error "更新过程中发生错误"; exit 1' ERR

main "$@"
