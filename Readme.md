# Discord.js Bot Project

## 项目结构

```
├── commands/                    # 命令处理模块
│   ├── adm_lockdown.js         # 服务器邀请控制
│   ├── adm_prune.js           # 子区不活跃用户清理
│   ├── adm_purge_channel.js   # 频道消息清理
│   ├── adm_shard_status.js    # 分片状态查看
│   ├── adm_sync_commands.js   # 同步Discord命令
│   ├── adm_update_analysis.js # 更新分析报告
│   ├── long_archive_thread.js # 清理不活跃子区
│   ├── mod_quick_lock.js      # 快速锁定帖子
│   ├── mod_senator_review.js  # 议员申请审核
│   ├── mod_thread.js          # 帖子管理
│   ├── user_notify.js         # 通知控件发送
│   └── user_self_manage.js    # 用户自助管理
├── events/                     # 事件处理模块
│   ├── interactionCreate.js   # 交互事件处理
│   └── ready.js               # 就绪事件处理
├── utils/                      # 工具类模块
│   ├── analyzers.js           # 子区分析工具
│   ├── concurrency.js         # 并发控制
│   ├── guild_config.js        # 服务器配置管理
│   ├── helper.js              # 通用辅助函数
│   ├── logger.js              # 日志管理
│   └── roleApplication.js     # 身份组申请处理
├── config.json                # 配置文件
├── index.js                   # 主入口文件
└── package.json              # 项目配置
```

## 命令模块

### 管理员命令

#### adm_lockdown.js - 服务器邀请控制
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 控制服务器邀请链接的启用/禁用
- 需要管理员权限
- 执行操作后发送管理日志
- 支持操作原因记录

#### adm_prune.js - 子区清理
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 支持单个子区或全服子区清理
- 可设置清理阈值(800-1000)
- 使用批处理器处理大量请求
- 发送清理报告和进度通知
- 自动重试失败的操作

#### adm_purge_channel.js - 频道消息清理
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 清理指定消息ID之前的所有消息
- 需要二次确认按钮
- 显示清理进度
- 记录清理操作日志

#### adm_shard_status.js - 系统状态查看
```javascript
export default {
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 显示当前系统运行状态
- 包含版本信息、运行时间
- 显示请求队列状态
- 显示内存使用情况

#### adm_sync_commands.js - 同步Discord命令
```javascript
export default {
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 同步本地命令到Discord服务器
- 显示同步进度和结果
- 自动处理命令差异
- 记录同步日志

#### adm_update_analysis.js - 更新分析报告
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 分析所有子区活跃度
- 生成统计报告
- 更新日志频道的分析信息
- 显示执行时间和处理结果

### 版主命令

#### mod_quick_lock.js - 快速锁定
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 快速锁定并归档当前帖子
- 需要管理消息权限
- 记录操作原因
- 发送通知和日志

#### mod_senator_review.js - 议员审核
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 快速处理议员申请帖
- 支持通过/拒绝操作
- 自动分配相关身份组
- 发送审核结果通知

#### mod_thread.js - 帖子管理
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 综合帖子管理功能
- 支持锁定/解锁/归档/开启/标注
- 通过帖子链接操作
- 记录操作原因和执行者

### 用户命令

#### user_notify.js - 发送通知
```javascript
export default {
    cooldown: 60,
    data: new SlashCommandBuilder()...
    async execute(interaction) {...}
}
```
- 创建自定义通知嵌入
- 支持标题、内容、图片
- 可选择不同颜色
- 带有60秒冷却时间

#### user_self_manage.js - 自助管理
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
- 用户管理自己的帖子
- 支持删除/锁定/标注操作
- 需要帖子作者权限
- 记录操作原因

### 自动化命令

#### long_archive_thread.js - 活跃贴清理
```javascript
export default {
    cooldown: 10,
    data: new SlashCommandBuilder()...
    async execute(interaction, guildConfig) {...}
}
```
**功能逻辑**:
- 清理不活跃的子区
- 可设置活跃度阈值
- 自动归档不活跃帖子
- 生成清理报告

所有命令都遵循以下通用处理流程：
1. 权限检查
2. 参数验证
3. 执行操作
4. 错误处理
5. 发送响应
6. 记录日志

## utils/ - 工具类函数

### helper.js - 通用辅助函数
```javascript
// 时间测量与延迟
export const measureTime = () => {...}           // 返回一个计时器函数
export const delay = (ms) => {...}              // Promise延迟函数

// 权限相关
export const checkPermission = (member, roles) => {...}     // 检查用户是否具有指定角色权限
export const handlePermissionResult = (interaction, result) => {...}  // 处理权限检查结果
export const checkChannelPermission = (channel, permission) => {...}  // 检查频道权限

// 帖子管理
export const lockAndArchiveThreadBase = (thread, reason) => {...}    // 基础帖子锁定和归档
export const lockAndArchiveThread = (thread, reason) => {...}        // 带通知的帖子锁定
export const lockAndArchiveThreadWithLog = (thread, reason, executor) => {...}  // 带日志的帖子锁定

// 日志与通知
export const sendModerationLog = (client, guildConfig, data) => {...}  // 发送管理操作日志
export const sendThreadNotification = (thread, notifyData) => {...}     // 发送帖子通知
export const sendCleanupReport = (thread, result) => {...}             // 发送清理报告

// 进度处理
export const generateProgressReport = (current, total, prefix) => {...}  // 生成进度报告文本
export const handleBatchProgress = (current, total, intervals, lastIndex, callback) => {...}  // 批处理进度处理

// 错误处理
export const handleCommandError = (interaction, error) => {...}  // 统一命令错误处理

// 文件加载
export const loadCommandFiles = (commandsPath) => {...}  // 加载命令文件
```

### analyzers.js - 分析工具
```javascript
// 主要分析函数
export const analyzeThreads = (client, guildConfig, guildId, options) => {...}  // 子区分析主函数

// 日志管理器类
export class DiscordLogger {
    constructor(client, guildId, guildConfig) {...}
    async initialize() {...}                    // 初始化日志频道
    async loadMessageIds() {...}                // 加载消息ID配置
    async saveMessageIds() {...}                // 保存消息ID配置
    async getOrCreateMessage(type) {...}        // 获取或创建消息
    async sendInactiveThreadsList() {...}       // 发送不活跃子区列表
    async sendStatisticsReport() {...}          // 发送统计报告
    async sendCleanReport() {...}               // 发送清理报告
}

// 错误处理
export const handleDiscordError = (error, context) => {...}  // Discord API错误处理
```

### cleaner.js - 清理工具
```javascript
// 清理功能
export const cleanThreadMembers = async (thread, options) => {...}  // 清理子区成员
export const sendThreadReport = async (thread, result) => {...}     // 发送子区清理报告
```

### concurrency.js - 并发控制
```javascript
// 请求队列
export class RequestQueue {
    constructor(options) {...}
    async add(task, priority) {...}             // 添加任务
    pause() {...}                               // 暂停队列
    resume() {...}                              // 恢复队列
    setShardStatus(shardId, status) {...}       // 设置分片状态
    adjustQueuePriorities() {...}               // 调整队列优先级
    process() {...}                             // 处理队列
    executeTask(item) {...}                     // 执行任务
}

// 速率限制器
export class RateLimiter {
    constructor(options) {...}
    async withRateLimit(fn) {...}               // 速率限制包装器
}

// 批处理器
export class BatchProcessor {
    constructor(options) {...}
    async processBatch(items, processor) {...}   // 批量处理
}

// 全局实例
export const globalRequestQueue = new RequestQueue({...})
export const globalRateLimiter = new RateLimiter({...})
export const globalBatchProcessor = new BatchProcessor({...})
```

### roleApplication.js - 身份组申请
```javascript
// 申请系统
export const createApplicationMessage = async (client, guildConfig) => {...}  // 创建申请消息
export const handleButtonInteraction = async (interaction) => {...}           // 处理按钮交互
export const handleModalSubmit = async (interaction) => {...}                 // 处理模态框提交
```

### guild_config.js - 服务器配置
```javascript
// 配置管理器
export class GuildManager {
    constructor() {...}
    initialize(config) {...}                    // 初始化配置
    getGuildConfig(guildId) {...}              // 获取服务器配置
    getGuildIds() {...}                        // 获取所有服务器ID
}
```

### logger.js - 日志系统
```javascript
// 日志函数
export const logTime = (message, isError = false) => {...}  // 带时间戳的日志记录

// Winston日志实例
export default logger;  // Winston日志记录器实例
```


## 依赖版本

```15:21:package.json
  "dependencies": {
    "discord.js": "^14.17.3",
    "node-cron": "^3.0.3",
    "undici": "^7.2.1",
    "winston": "^3.11.0",
    "winston-daily-rotate-file": "^5.0.0"
  },
```

