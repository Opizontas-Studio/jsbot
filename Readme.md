Discord.js Bot Project

# 项目结构

```
├── commands/                    # 命令处理模块
│   ├── adm_*.js                # 管理员命令
│   ├── mod_*.js                # 版主命令
│   ├── user_*.js               # 用户命令
│   └── long_*.js               # 长时间运行的后台命令
├── events/                     # 事件处理模块
│   ├── interactionCreate.js   # 交互事件处理
│   └── ready.js               # 就绪事件处理
├── handlers/                   # 交互处理模块
│   ├── buttons.js             # 按钮交互处理
│   └── modals.js              # 模态框交互处理
├── db/                         # 数据库模块
│   ├── db.js                  # 数据库管理器
│   ├── punishment.js          # 处罚数据模型
│   └── process.js             # 流程数据模型
├── utils/                      # 工具类模块
│   ├── analyzers.js           # 活跃子区分析工具
│   ├── cleaner.js             # 子区成员清理工具
│   ├── concurrency.js         # 队列和并发控制
│   ├── guild_config.js        # 服务器配置管理
│   ├── helper.js              # 通用辅助函数
│   ├── logger.js              # 日志管理
│   └── roleApplication.js     # 身份组申请处理
├── tasks/                      # 定时任务模块
│   └── scheduler.js           # 定时任务管理器
├── data/                      # 数据存储目录
│   ├── database.sqlite        # SQLite数据库文件
│   └── messageIds.json        # 消息ID配置
├── config.json                # 配置文件
├── index.js                   # 主入口文件
├── package.json              # 项目配置
└── eslint.config.js          # ESLint配置
```



# commands/ - Discord命令

## 设计规范

所有命令都遵循以下通用处理流程：
1. 权限检查 - 验证用户是否有权限执行命令
2. 参数验证 - 检查命令参数的有效性
3. 执行操作 - 执行具体的命令逻辑
4. 错误处理 - 捕获和处理可能的错误
5. 发送响应 - 向用户返回执行结果
6. 记录日志 - 记录命令执行的关键信息

命令文件命名规则：
- `adm_*.js` - 管理员命令，最高优先级(5)
- `mod_*.js` - 版主命令，次高优先级(4)
- `user_*.js` - 用户命令，中等优先级(3)
- `long_*.js` - 后台任务，较低优先级(2)

## 管理员命令

### adm_lockdown.js - 服务器邀请控制
- 控制服务器邀请链接的启用/禁用
- 需要管理员权限
- 执行操作后发送管理日志
- 支持操作原因记录

### adm_prune.js - 子区清理
- 支持单个子区或全服子区清理
- 可设置清理阈值(800-1000)
- 使用批处理器处理大量请求
- 发送清理报告和进度通知
- 自动重试失败的操作

### adm_purge_channel.js - 频道消息清理
- 清理指定消息ID之前的所有消息
- 需要二次确认按钮
- 显示清理进度
- 记录清理操作日志

### adm_shard_status.js - 系统状态查看
- 显示当前系统运行状态
- 包含版本信息、运行时间
- 显示请求队列状态
- 显示内存使用情况

### adm_sync_commands.js - 同步Discord命令
- 同步本地命令到Discord服务器
- 显示同步进度和结果
- 自动处理命令差异
- 记录同步日志

## 版主命令

### mod_quick_lock.js - 快速锁定
- 快速锁定并归档当前帖子
- 需要管理消息权限
- 记录操作原因
- 发送通知和日志

### mod_senator_review.js - 议员审核
- 快速处理议员申请帖
- 支持通过/拒绝操作
- 自动分配相关身份组
- 发送审核结果通知

### mod_thread_manage.js - 帖子管理
- 支持帖子锁定、解锁、开启、关闭、标注、取消标注操作
- 需要该频道管理消息权限
- 解锁锁定会发送操作通知到帖子中

## 用户命令

### user_dm.js - 发送私聊通知
- 通过机器人向指定用户发送私聊通知
- 需要目标用户权限
- 支持标题、内容、图片URL
- 提供多种颜色选择（蓝色、绿色、紫色、粉色、青色）
- 带有60秒冷却时间
- 自动添加发送者信息和时间戳

### user_notify.js - 发送通知
- 创建自定义通知嵌入消息
- 支持标题、内容、图片URL
- 提供多种颜色选择（蓝色、绿色、紫色、粉色、青色）
- 带有60秒冷却时间
- 自动添加发送者信息和时间戳
- 支持4096字符的内容长度

### user_self_manage.js - 自助管理
- 用户管理自己的帖子
- 支持删除/锁定/标注/清理不活跃用户操作
- 需要帖子作者权限
- 记录操作原因
- 发送操作通知到帖子中
- 支持撤销部分操作

## 后台命令

### long_archive_thread.js - 活跃贴清理
- 清理不活跃的子区
- 可设置活跃度阈值
- 自动归档不活跃帖子
- 生成清理报告
- 支持白名单配置

### long_prune.js - 子区成员清理
- 支持单个子区或全服清理模式
- 可设置目标人数阈值(800-1000)
- 使用批处理器处理大量请求
- 自动识别并保留活跃成员
- 发送详细的清理报告
- 支持进度实时显示
- 自动跳过白名单子区

### long_purge_channel.js - 频道消息清理
- 清理指定消息ID之前的所有消息
- 支持二次确认机制
- 自动区分新旧消息处理
- 批量删除14天内消息
- 单条删除超过14天消息
- 显示实时清理进度
- 生成详细的清理日志
- 操作超时自动取消

### long_update_analysis.js - 更新分析报告
- 分析所有子区活跃度
- 生成统计报告
- 更新日志频道的分析信息
- 显示执行时间和处理结果
- 记录处理失败的操作
- 支持自动化定时执行
- 可配置分析范围和阈值

# events/ - 事件处理模块

## interactionCreate.js
- 定义：处理所有的Discord交互事件
- 导出：`client.on(Events.InteractionCreate, async (interaction) => {...})`
- 功能：
  * 处理斜杠命令执行
  * 处理按钮交互
  * 处理模态框提交
  * 实现命令冷却时间
  * 管理命令优先级队列

## ready.js
- 定义：处理机器人启动就绪事件
- 导出：`client.once(Events.ClientReady, async (client) => {...})`
- 功能：
  * 初始化定时分析任务
  * 创建身份组申请消息
  * 设置分片状态
  * 监听分片状态变化

# handlers/ - 交互处理模块

## buttons.js - 按钮交互处理
- 定义：统一管理所有按钮交互的处理逻辑
- 导出：`handleConfirmationButton({ interaction, customId, buttonLabel, embed, onConfirm, onTimeout, onError })`
- 功能：
  * 通用确认按钮处理
  * 按钮交互路由分发
  * 错误处理和日志记录
  * 支持自定义超时时间
  * 提供进度反馈机制

## modals.js - 模态框交互处理
- 定义：统一管理所有模态框交互的处理逻辑
- 导出：`handleModal({ interaction, customId, fields, validator, onSubmit, onError })`
- 功能：
  * 模态框提交验证
  * 表单数据处理
  * 错误处理和反馈
  * 支持多步骤表单
  * 提供字段验证机制

# db/ - 数据库模块
- 使用SQLite3作为轻量级数据库
- 数据文件位于`data/database.sqlite`
- 自动创建表结构和索引
- 支持外键约束和级联删除
- 使用JSON字段存储复杂数据
- 自动管理时间戳
- 内置数据完整性检查

## punishments.js - 处罚记录表
```sql
CREATE TABLE punishments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,           -- 被处罚用户ID
    guildId TEXT NOT NULL,          -- 服务器ID
    type TEXT NOT NULL,             -- 处罚类型：ban/mute/warn
    reason TEXT NOT NULL,           -- 处罚原因
    duration INTEGER NOT NULL,      -- 持续时间（毫秒）
    expireAt INTEGER NOT NULL,      -- 到期时间
    executorId TEXT NOT NULL,       -- 执行者ID
    status TEXT NOT NULL,           -- 状态：active/expired/appealed/revoked
    synced INTEGER DEFAULT 0,       -- 是否已同步
    syncedServers TEXT,            -- 已同步的服务器列表（JSON数组）
    createdAt INTEGER,             -- 创建时间
    updatedAt INTEGER              -- 更新时间
)
```

## processes.js - 流程记录表
```sql
CREATE TABLE processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    punishmentId INTEGER NOT NULL,  -- 关联的处罚ID
    type TEXT NOT NULL,             -- 流程类型：appeal/vote/debate
    status TEXT NOT NULL,           -- 状态：pending/in_progress/completed/rejected/cancelled
    createdAt INTEGER,             -- 创建时间
    expireAt INTEGER NOT NULL,      -- 到期时间
    messageIds TEXT,               -- 相关消息ID列表（JSON数组）
    votes TEXT,                    -- 投票记录（JSON对象）
    result TEXT,                   -- 结果：approved/rejected/cancelled
    reason TEXT,                   -- 原因
    updatedAt INTEGER,             -- 更新时间
    FOREIGN KEY(punishmentId) REFERENCES punishments(id) ON DELETE CASCADE
)
```

# tasks/ - 定时任务模块

## scheduler.js - 定时任务管理器
- 定义：统一管理所有定时任务的调度和执行
导出：`globalTaskScheduler.schedule({ name, interval, task, onError, retryCount })`

# utils/ - 工具类模块

## analyzers.js - 分析工具
- 主要分析函数
- 导出：`const analyzeThreads = (client, guildConfig, guildId, options) => {...}`  // 子区分析主函数

- 日志管理器类
导出：
class DiscordLogger {
    constructor(client, guildId, guildConfig) {...}  // 构造函数
    async initialize() {...}                         // 初始化日志频道
    async loadMessageIds() {...}                     // 加载消息ID配置
    async saveMessageIds() {...}                     // 保存消息ID配置
    async getOrCreateMessage(type) {...}             // 获取或创建消息
    async sendInactiveThreadsList() {...}            // 发送不活跃子区列表
    async sendStatisticsReport() {...}               // 发送统计报告
    async sendCleanReport() {...}                    // 发送清理报告
}

- 错误处理
导出：`const handleDiscordError = (error, context) => {...}`  // Discord API错误处理

### cleaner.js - 清理工具
导出：`const cleanThreadMembers = async (thread, options) => {...}`  // 清理子区成员
导出：`const sendThreadReport = async (thread, result) => {...}`     // 发送子区清理报告
导出：`async function handleSingleThreadCleanup(interaction, guildConfig) {...}` // 处理单个子区清理

### concurrency.js - 并发控制
导出：
class RequestQueue {
    constructor(options) {...}                      // 构造函数
    async add(task, priority) {...}                // 添加任务
    pause() {...}                                  // 暂停队列
    resume() {...}                                 // 恢复队列
    setShardStatus(shardId, status) {...}         // 设置分片状态
    adjustQueuePriorities() {...}                 // 调整队列优先级
    process() {...}                               // 处理队列
    executeTask(item) {...}                       // 执行任务
}

class RateLimiter {
    constructor(options) {...}                     // 构造函数
    async withRateLimit(fn) {...}                 // 速率限制包装器
}

class BatchProcessor {
    constructor(options) {...}                     // 构造函数
    async processBatch(items, processor) {...}     // 批量处理
}

导出：`const globalRequestQueue = new RequestQueue({...})     // 全局请求队列实例`
导出：`const globalRateLimiter = new RateLimiter({...})      // 全局速率限制器实例`
导出：`const globalBatchProcessor = new BatchProcessor({...}) // 全局批处理器实例`

## utils/db.js - 数据库管理
- 数据库文件自动创建和初始化
- 自动备份和恢复机制
- 支持事务处理
- 内置错误处理和重试机制
- 连接池管理
- 自动清理过期数据

## guild_config.js - 服务器配置
导出：
class GuildManager {
    constructor() {...}                           // 构造函数
    initialize(config) {...}                      // 初始化配置
    getGuildConfig(guildId) {...}                // 获取服务器配置
    getGuildIds() {...}                          // 获取所有服务器ID
}

## helper.js - 通用辅助函数
导出：
// 时间和延迟
导出：`const measureTime = () => {...}`                                           // 计时器函数
导出：`const delay = (ms) => {...}` 

// 处理Discord API错误
导出：`const handleDiscordError = (error) => {...}`                             // 处理Discord API错误

// 权限检查
导出：`const checkPermission = (member, roles) => {...}`                         // 检查角色权限
导出：`const handlePermissionResult = (interaction, result) => {...}`            // 处理权限结果
导出：`const checkChannelPermission = (channel, permission) => {...}`            // 检查频道权限

// 帖子管理
导出：`const lockAndArchiveThreadBase = (thread, reason) => {...}`               // 基础帖子锁定
导出：`const lockAndArchiveThread = (thread, reason) => {...}`                   // 带通知的锁定
导出：`const lockAndArchiveThreadWithLog = (thread, reason, executor) => {...}`  // 带日志的锁定

// 日志和通知
  导出：`const sendModerationLog = (client, guildConfig, data) => {...}`          // 发送管理日志
导出：`const sendThreadNotification = (thread, notifyData) => {...}`            // 发送帖子通知
导出：`const sendCleanupReport = (thread, result) => {...}`                     // 发送清理报告

// 进度处理
导出：`const generateProgressReport = (current, total, prefix) => {...}`         // 生成进度报告
导出：`const handleBatchProgress = (current, total, intervals, lastIndex, callback) => {...}`  // 处理批量进度

// 错误处理
导出：`const handleCommandError = (interaction, error) => {...}`                 // 统一错误处理

// 文件处理
导出：`const loadCommandFiles = (commandsPath) => {...}`                         // 加载命令文件

## logger.js - 日志系统
导出：`const logTime = (message, isError = false) => {...}`  // 带时间戳的日志记录
导出：`export default logger  // Winston日志记录器实例`

## roleApplication.js - 创作者身份组申请
导出：`const createApplicationMessage = async (client, guildConfig) => {...}`  // 创建申请消息

# 主要文件说明

## index.js - 主入口文件
- 初始化Discord客户端
- 加载事件处理器
- 设置进程事件处理
- 加载命令文件
- 部署Discord命令
- 启动机器人服务

## config.json - 配置文件
- Discord Bot Token
- 服务器配置
- 命令部署状态
- 自动化任务配置
- 日志频道配置