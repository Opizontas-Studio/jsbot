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
│   └── scheduler.js           # 定时任务管理器
├── db/                         # 数据库模块
│   ├── manager.js             # 数据库管理器
│   ├── models/                # 数据模型目录
│   │   ├── punishment.js      # 处罚数据模型
│   │   └── process.js         # 流程数据模型
├── utils/                      # 工具类模块
│   ├── concurrency.js         # 队列和并发控制
│   ├── guild_config.js        # 服务器配置管理
│   ├── helper.js              # 通用辅助函数
│   ├── logger.js              # 日志管理
│   └── punishment_helper.js    # 处罚相关辅助函数
├── services/                   # 服务类模块
│   ├── analyzers.js           # 活跃子区分析工具
│   ├── cleaner.js             # 子区成员清理工具
│   ├── punishment_service.js   # 处罚系统服务
│   └── roleApplication.js     # 身份组申请处理
├── data/                      # 数据存储目录
│   ├── database.sqlite        # SQLite数据库文件
│   └── messageIds.json        # 消息ID配置
├── config.json                # 配置文件
├── index.js                   # 主入口文件
├── package.json              # 项目配置
├── eslint.config.js          # ESLint配置
└── Readme.md                 # 项目说明
```



# commands/ - Discord命令

## 设计规范

所有命令都遵循以下通用处理流程：
0. 正确调用工具函数
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

### adm_query_records.js - 处罚记录查询
- 查询指定用户的处罚记录
- 支持多种查询条件筛选
- 分页显示查询结果
- 显示处罚详细信息
- 支持导出查询结果

### adm_shard_status.js - 系统状态查看
- 显示当前系统运行状态
- 包含版本信息、运行时间、内存使用情况
- 显示请求队列状态和处理情况
- 支持3秒冷却时间
- 自动刷新状态信息

### adm_sync_commands.js - 同步Discord命令
- 同步本地命令到Discord服务器
- 显示同步进度和结果
- 自动处理命令差异
- 记录同步日志

## 版主命令

### mod_punish.js - 处罚系统
- 支持警告/禁言/封禁等多种处罚类型
- 自动同步处罚到其他服务器
- 支持处罚原因记录
- 支持处罚时长设置
- 自动处理处罚到期
- 记录完整处罚历史

### mod_quick_lock.js - 快速锁定
- 快速锁定并归档当前帖子
- 需要管理消息权限
- 记录操作原因
- 发送通知和日志

### mod_senator_review.js - 议员审核
- 快速处理议员申请帖
- 需要管理身份组权限
- 自动检查申请者加入时间(需满15天)
- 自动统计作品反应数(需满50个)
- 支持多个作品链接检查
- 自动分配议员身份组
- 发送详细的审核结果通知
- 记录审核操作日志

### mod_thread.js - 帖子管理
- 支持帖子锁定、解锁、开启、关闭、标注、取消标注操作
- 需要该频道管理消息权限
- 解锁锁定会发送操作通知到帖子中

## 用户命令

### user_dm.js - 发送私聊通知
- 通过机器人向指定用户发送私聊通知
- 需要目标用户权限
- 支持标题(最大256字符)和内容(最大4096字符)
- 支持可选的图片URL
- 提供多种颜色选择(蓝色、绿色、紫色、粉色、青色)
- 带有60秒冷却时间
- 自动添加发送者信息和时间戳

### user_notify.js - 发送通知
- 在当前频道发送通知控件
- 支持标题(最大256字符)和内容(最大4096字符)
- 支持可选的图片URL
- 提供多种颜色选择(蓝色、绿色、紫色、粉色、青色)
- 带有60秒冷却时间
- 自动添加发送者信息和时间戳

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
- 发送详细的清理报告
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
  
## scheduler.js - 定时任务管理器
- 定义：统一管理所有定时任务的调度和执行
- 导出：`globalTaskScheduler.schedule({ name, interval, task, onError, retryCount })`

# db/ - 数据库模块

## db.js - 数据库管理器
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
    type TEXT NOT NULL,             -- 处罚类型：ban/mute
    reason TEXT NOT NULL,           -- 处罚原因
    duration INTEGER NOT NULL,      -- 持续时间（毫秒），永封为-1
    warningDuration INTEGER,        -- 警告持续时间（毫秒）
    executorId TEXT NOT NULL,       -- 执行者ID
    status TEXT NOT NULL,           -- 状态：active/expired/appealed/revoked
    synced INTEGER DEFAULT 0,       -- 是否已同步
    syncedServers TEXT DEFAULT '[]', -- 已同步的服务器列表（JSON数组）
    keepMessages INTEGER DEFAULT 0,  -- 是否保留消息
    channelId TEXT,                 -- 处罚执行的频道ID
    createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000), -- 创建时间戳
    updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)  -- 更新时间戳
)
```

## processes.js - 流程记录表
```sql
CREATE TABLE processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    punishmentId INTEGER NOT NULL,  -- 关联的处罚ID
    type TEXT NOT NULL,             -- 流程类型：appeal/vote/debate
    status TEXT NOT NULL,           -- 状态：pending/in_progress/completed/rejected/cancelled
    expireAt INTEGER NOT NULL,      -- 到期时间戳
    messageIds TEXT DEFAULT '[]',   -- 相关消息ID列表（JSON数组）
    votes TEXT DEFAULT '{}',        -- 投票记录（JSON对象）
    redClaim TEXT,                 -- 红方诉求
    blueClaim TEXT,                -- 蓝方诉求
    result TEXT,                   -- 结果：approved/rejected/cancelled
    reason TEXT,                   -- 结果原因
    createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000), -- 创建时间戳
    updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000), -- 更新时间戳
    FOREIGN KEY(punishmentId) REFERENCES punishments(id) ON DELETE CASCADE
)
```

# services/ - 服务类模块

## analyzers.js - 活跃子区分析工具
- `analyzeThreads(client, guildConfig)` - 分析所有子区活跃度
  * 参数: Discord客户端、服务器配置
  * 返回: 分析结果
  * 支持自动化定时执行
  * 可配置分析范围和阈值

## cleaner.js - 清理工具
- `sendThreadReport(thread, result)` - 发送子区清理报告
  * 参数: 子区对象、清理结果
  * 支持详细的统计信息显示
- `cleanThreadMembers(thread, threshold, options, progressCallback)` - 清理子区成员
  * 参数: 子区对象、目标阈值、选项、进度回调
  * 支持白名单检查
  * 自动识别活跃/不活跃成员
  * 批量处理成员移除
  * 支持进度报告
- `handleSingleThreadCleanup(interaction, guildConfig)` - 处理单个子区清理
  * 参数: 交互对象、服务器配置
  * 支持阈值自定义
  * 自动检查权限和条件
  * 发送清理结果通知

## punishment_service.js - 处罚系统服务
- `executePunishment(interaction, punishmentData)` - 执行处罚
  * 参数: 交互对象、处罚数据
  * 支持多种处罚类型
  * 自动同步到其他服务器
  * 处理处罚到期
  * 记录处罚历史
- `syncPunishment(punishment, targetGuilds)` - 同步处罚
  * 参数: 处罚对象、目标服务器列表
  * 确保处罚在所有服务器生效
  * 处理同步失败的情况
- `checkExpiredPunishments()` - 检查过期处罚
  * 自动解除过期处罚
  * 发送处罚解除通知
  * 更新处罚状态

## roleApplication.js - 身份组申请
- `createApplicationMessage(client)` - 创建申请消息
  * 参数: Discord客户端
  * 自动检查现有消息
  * 创建申请按钮和说明
  * 保存消息ID配置
  * 支持功能开关检查
  * 自动清理失效消息

# utils/ - 工具类模块

## helper.js - 通用辅助函数
- `measureTime()` - 计算执行时间的工具函数
  * 返回一个函数,调用时返回从开始到现在的秒数(保留两位小数)
- `delay(ms)` - 延迟函数
  * 参数: 延迟时间(毫秒)
  * 返回: Promise
- `handleDiscordError(error)` - 处理Discord API错误
  * 参数: 错误对象
  * 返回: 格式化的错误信息
  * 支持多种Discord错误码的中文提示
- `lockAndArchiveThread(thread, executor, reason, options)` - 锁定并归档帖子
  * 参数: 帖子对象、执行者、原因、选项
  * 支持管理员和楼主两种操作模式
  * 自动发送通知和日志
- `sendModerationLog(client, moderationChannelId, logData)` - 发送操作日志
  * 参数: Discord客户端、管理频道ID、日志数据
  * 支持标准化的日志格式
- `sendThreadNotification(thread, notifyData)` - 发送帖子通知
  * 参数: 帖子对象、通知数据
  * 支持标准化的通知格式
- `generateProgressReport(current, total, prefix)` - 生成进度报告
  * 参数: 当前进度、总数、前缀文本
  * 返回: 格式化的进度信息
- `handleBatchProgress(current, total, intervals, lastIndex, callback)` - 处理分批进度
  * 参数: 当前进度、总数、间隔点数组、上次索引、回调函数
  * 返回: 新的进度索引
- `handleCommandError(interaction, error, commandName)` - 统一处理命令错误
  * 参数: 交互对象、错误对象、命令名称
  * 自动处理延迟回复情况
- `sendCleanupReport(interaction, guildConfig, result)` - 发送清理报告
  * 参数: 交互对象、服务器配置、清理结果
  * 支持详细的清理统计信息
- `loadCommandFiles(commandsDir, excludeFiles)` - 加载命令文件
  * 参数: 命令目录路径、排除文件数组
  * 返回: 命令映射Map
  * 支持错误处理和重复检查
- `getVersionInfo()` - 获取应用程序版本信息
  * 返回: 包含版本号、提交哈希和提交日期的对象

## logger.js - 日志系统
- Winston日志记录器配置
  * 支持控制台和文件双重输出
  * 日志文件按日期自动轮转
  * 保留14天的日志记录
  * 最大单文件大小20MB
- `logTime(message, isError)` - 记录时间日志
  * 参数: 日志消息、是否为错误日志
  * 自动添加时间戳
  * 错误日志带有❌标记

## concurrency.js - 并发控制
- RequestQueue类 - 全局请求队列
  * 控制并发请求数量(最大5个)
  * 支持任务优先级
  * 自动重试机制(最多2次)
  * 支持暂停/恢复
  * 分片状态管理
  * 详细的统计信息
- BatchProcessor类 - 批量处理器
  * 支持多种任务类型的配置
  * 自动控制批次大小和延迟
  * 支持进度回调
  * 预设配置:
    - threadCheck: 45批/100ms
    - threadAnalysis: 25批/500ms
    - messageHistory: 10批/300ms
    - memberRemove: 5批/500ms

## guild_config.js - 服务器配置管理
- GuildManager类
  * 初始化服务器配置
  * 管理自动化功能开关
  * 支持白名单配置
  * 阈值设置
  * 日志频道配置
  * 状态信息构建

## punishment_helper.js - 处罚辅助函数
- `formatPunishmentEmbed(punishment)` - 格式化处罚信息
  * 参数: 处罚对象
  * 返回: 格式化的处罚信息嵌入
- `validatePunishmentDuration(duration)` - 验证处罚时长
  * 参数: 处罚时长
  * 返回: 验证结果
- `calculateExpireTime(duration)` - 计算到期时间
  * 参数: 处罚时长
  * 返回: 到期时间戳

# 主要文件说明

## index.js - 主入口文件
- 初始化Discord客户端(使用最新的Discord.js v14)
- 设置客户端选项
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