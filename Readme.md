# Discord.js Bot Project

## 使用

将 `config.json` 放在根目录下, 将 `messageIds.json` 放在 `data` 文件夹下

安装 pnpm:

```bash
npm -g pnpm
```

用 pnpm 安装依赖包并运行:

```bash
pnpm install
pnpm start
```

## 项目结构

```txt
├── src/
│   ├── commands/                  # 命令处理模块
│   │   ├── adm_*.js               # 管理员命令
│   │   ├── mod_*.js               # 版主命令
│   │   ├── user_*.js              # 用户命令
│   │   └── long_*.js              # 长时间运行的后台命令
│   │
│   ├── events/                    # 事件处理模块
│   │   ├── interactionCreate.js   # 交互事件处理
│   │   └── ready.js               # 就绪事件处理
│   │
│   ├── handlers/                  # 交互处理模块
│   │   ├── buttons.js             # 按钮交互处理
│   │   ├── modals.js              # 模态框交互处理
│   │   └── scheduler.js           # 定时任务管理器
│   │
│   ├── db/                        # 数据库模块
│   │   ├── dbManager.js           # 数据库管理器
│   │   └── models/                # 数据模型目录
│   │       ├── punishmentModel.js # 处罚数据模型
│   │       └── processModel.js    # 流程数据模型
│   │
│   ├── utils/                     # 工具类模块
│   │   ├── concurrency.js         # 队列和并发控制
│   │   ├── guildManager.js        # 服务器配置管理
│   │   ├── helper.js              # 通用辅助函数
│   │   ├── logger.js              # 日志管理
│   │   └── punishmentHelper.js    # 处罚相关辅助函数
│   │
│   └── services/                  # 服务类模块
│       ├── courtService.js        # 议事系统服务
│       ├── threadAnalyzer.js      # 活跃子区分析工具
│       ├── threadCleaner.js       # 子区成员清理工具
│       ├── punishmentService.js   # 处罚系统服务
│       └── roleApplication.js     # 身份组申请处理
│
├── test/
│
├── data/                # 数据存储目录
│   ├── database.sqlite  # SQLite数据库文件
│   └── messageIds.json  # 消息ID配置
│
├── logs/  # 日志文件目录
│
├── config.json       # 配置文件
├── index.js          # 主入口文件
├── package.json      # 项目配置
└── eslint.config.js  # ESLint配置
```

## commands/ - Discord命令

### 命令设计规范

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

### 服务设计规范

1. 单一职责原则

- 每个服务类专注于处理特定的业务领域
- 避免跨域调用，通过事件或回调进行通信
- 保持功能的内聚性和独立性

2. 错误处理规范

- 所有异步操作都使用 try-catch 包装
- 统一使用 logTime() 记录错误信息
- 对外抛出的错误应该包含足够的上下文信息

3. 并发控制

- 使用 globalBatchProcessor 处理批量操作
- 使用 globalRequestQueue 控制 API 请求频率
- 合理设置任务优先级(1-5)，避免阻塞关键操作

4. 数据持久化

- 配置数据统一存储在 data/ 目录
- 使用 JSON 格式存储配置和状态
- 定期保存重要数据，避免数据丢失

5. 通用规范：

- 所有服务类方法都应该是静态的
- 避免在服务类中保存状态
- 使用 JSDoc 注释文档化所有公共方法
- 合理使用工具函数，避免代码重复

## db/ - 数据库模块

### dbManager.js - 数据库管理器

- 使用SQLite3作为轻量级数据库
- 数据文件位于`data/database.sqlite`
- 自动创建表结构和索引
- 支持外键约束和级联删除

### models/punishmentModel.js - 处罚记录表

```sql
CREATE TABLE punishments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 userId TEXT NOT NULL,           -- 被处罚用户ID
 type TEXT NOT NULL CHECK(type IN ('ban', 'mute', 'warn')), -- 处罚类型
 reason TEXT NOT NULL,           -- 处罚原因
 duration INTEGER NOT NULL DEFAULT -1, -- 持续时间（毫秒），永封为-1
 warningDuration INTEGER DEFAULT NULL, -- 警告时长
 executorId TEXT NOT NULL,       -- 执行者ID
 status TEXT NOT NULL DEFAULT 'active' -- 状态
     CHECK(status IN ('active', 'expired', 'appealed', 'revoked')),
 synced INTEGER DEFAULT 0,       -- 是否已同步
 syncedServers TEXT DEFAULT '[]', -- 已同步的服务器列表（JSON数组）
 keepMessages INTEGER DEFAULT 0,  -- 是否保留消息
 channelId TEXT,                -- 处罚执行的频道ID
 createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000), -- 创建时间
 updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)  -- 更新时间
)
```

### models/processModel.js - 流程记录表

```sql
CREATE TABLE processes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 type TEXT NOT NULL CHECK(       -- 流程类型
     type IN ('appeal', 'vote', 'debate', 'court_mute', 'court_ban')
 ),
 targetId TEXT NOT NULL,         -- 目标用户ID
 executorId TEXT NOT NULL,       -- 执行者ID
 messageId TEXT UNIQUE NOT NULL, -- 议事消息ID
 debateThreadId TEXT,            -- 辩诉帖子ID
 status TEXT NOT NULL DEFAULT 'pending' -- 状态
     CHECK(status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
 expireAt INTEGER NOT NULL,      -- 到期时间
 details TEXT DEFAULT '{}',      -- 处理详情（JSON对象）
 supporters TEXT DEFAULT '[]',   -- 支持者列表（JSON数组）
 result TEXT CHECK(result IN ('approved', 'rejected', 'cancelled', NULL)), -- 结果
 reason TEXT DEFAULT '',         -- 原因
 statusMessageId TEXT,           -- 状态消息ID（仅vote类型使用）
 createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000), -- 创建时间
 updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)  -- 更新时间
)
```

## 主要文件说明

### index.js - 主入口文件

- 初始化Discord客户端(使用最新的Discord.js v14)
- 设置客户端选项
- 加载事件处理器
- 设置进程事件处理
- 加载命令文件
- 部署Discord命令
- 启动机器人服务

### config.json - 配置文件

- Discord Bot Token
- 服务器配置
- 命令部署状态
- 自动化任务配置
- 日志频道配置
