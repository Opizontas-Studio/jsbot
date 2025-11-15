# Gatekeeper in Horizon Bot Project

基于Discord.js的Discord bot项目，提供服务器管理、楼主自动化等功能。

## 📋 环境要求

- Node.js 18.x 或更高版本
- pnpm 包管理器
- PM2 进程管理器（生产环境）

### 本地开发

1. **安装依赖**

```bash
# 安装pnpm
npm install -g pnpm

# 安装项目依赖
pnpm install
```

2. **配置文件**

在根目录创建 `config.json`：
- 参考 `config.example.json` 填写配置
- 包含 Discord bot token 和服务器配置
- 不需要的模块将 `enabled` 设置为 `false`

在 `data` 目录创建 `messageIds.json`：
- 参考 `messageIds.example.json` 填写
- 如果 `data` 目录不存在，需要先创建

3. **运行Bot**

```bash
pnpm start
```

> ⚠️ **Windows用户注意**：由于 `discord.js` 的限制，在 Windows 下必须开启 TUN 代理模式才能正常运行。

---

## 🐧 Linux生产环境部署

### 1. 环境准备

```bash
# 安装全局工具
npm install -g pnpm pm2

# （可选）安装jq用于监控内存使用
sudo apt install jq
```

### 2. 部署Bot

```bash
# 克隆或上传项目到服务器
cd /path/to/jsbot

# 安装依赖
pnpm install

# 添加脚本执行权限
chmod +x start.sh update.sh

# 配置config.json（参考config.example.json）
# 配置data/messageIds.json（参考messageIds.example.json）

# 启动Bot
./start.sh
```

### 3. 管理命令

#### 基本操作

```bash
# 查看Bot状态
pm2 status

# 查看日志
pm2 logs gatekeeper

# 查看最近50行日志
pm2 logs gatekeeper --lines 50

# 重启Bot
pm2 restart gatekeeper

# 停止Bot
pm2 stop gatekeeper

# 删除Bot进程
pm2 delete gatekeeper
```

#### 更新Bot

```bash
# 拉取最新代码并重载（零停机）
./update.sh
```

#### 监控模式

启动自动监控，定期检查Bot状态和内存使用：

```bash
# 前台运行（测试用）
./start.sh --monitor

# 后台运行（推荐）
nohup ./start.sh --monitor > monitor.log 2>&1 &

# 查看监控日志
tail -f monitor.log
```

监控功能：
- 每5分钟检查Bot是否在线，异常时自动重启
- 内存使用超过900MB时自动重启
- 需要安装 `jq` 才能启用内存监控

---

## 📁 项目结构

```
jsbot/
├── src/                  # 源代码目录
│   ├── commands/        # Discord命令
│   ├── events/          # Discord事件处理
│   ├── handlers/        # 交互处理器（按钮、模态框、定时任务）
│   ├── services/        # 业务逻辑服务
│   ├── db/              # 数据库管理
│   └── utils/           # 工具函数
├── data/                # 数据存储目录
├── logs/                # 日志文件
├── config.json          # 主配置文件（需自行创建）
├── start.sh             # 启动脚本
└── update.sh            # 更新脚本
```

---

## ⚙️ 配置说明

### config.json

主配置文件，包含：
- `token`: Discord Bot Token
- `guilds`: 服务器配置，支持多服务器
  - 命令权限配置
  - 功能模块开关
  - 频道和角色ID配置

详细配置项请参考 `config.example.json`。

### 环境变量

脚本中的关键配置（可在 `start.sh` 中修改）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APP_NAME` | `gatekeeper` | PM2应用名称 |
| `MAX_MEMORY` | `1G` | 最大内存限制 |
| `CRON_RESTART` | `0 0 */7 * *` | 定时重启（每7天） |
| `MONITOR_INTERVAL` | `300` | 监控检查间隔（秒） |
| `MEMORY_THRESHOLD` | `900000000` | 内存重启阈值（字节） |

---

## 🔧 故障排除

### Bot无法启动

```bash
# 检查日志
pm2 logs gatekeeper --err

# 检查配置文件
cat config.json

# 验证Node.js版本
node -v

# 重新安装依赖
pnpm install
```

### 内存占用过高

```bash
# 调整内存限制（编辑start.sh）
MAX_MEMORY="2G"  # 改为2GB

# 手动重启
pm2 restart gatekeeper
```

### 监控脚本不工作

```bash
# 检查jq是否安装
jq --version

# 安装jq
sudo apt install jq

# 查看监控日志
pm2 logs gatekeeper
```
