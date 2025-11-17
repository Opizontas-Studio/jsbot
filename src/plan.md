# Gatekeeper Bot 架构文档

## 架构概述

本项目采用现代化的模块化架构，已从旧版本完全重写。旧代码已归档至 `archive/src.old` 目录。

新架构特点：配置驱动模块、基础设施层统一管理数据库/缓存/队列/锁、模块自治、依赖注入。

## 架构设计

### 核心理念

**配置式注册** - 每个命令/组件/事件导出标准配置对象，核心自动扫描注册

**依赖外包** - 使用成熟库处理队列、缓存、调度等通用问题

**模块自治** - 业务模块完全独立，通过统一接口与核心交互

**component v2交互** - 主要交互均有componentv2返回，避免embed，除非明确要求，否则不返回text

**统一API包装** - 所有Discord API调用通过ApiClient包装，实现完整的监控和速率控制

**配置驱动** - 所有限速策略、并发控制、功能开关均通过配置文件管理，无需修改代码

### 目录结构

```
src/
├── core/                              # 核心框架
│   ├── Application.js                # 应用主入口
│   ├── ClientFactory.js              # Discord Client工厂
│   ├── Container.js                  # 服务容器（DI，仅singleton）
│   ├── Registry.js                   # 注册中心（扫描配置并路由）
│   ├── Context.js                    # 上下文对象（统一包装interaction）
│   ├── Logger.js                     # 日志器（基于pino）
│   ├── CommandDeployer.js            # 命令部署器
│   ├── ModuleReloader.js             # 模块热重载
│   ├── bootstrap/                    # 启动引导
│   │   ├── services.js              # 服务注册
│   │   ├── middlewares.js           # 中间件配置
│   │   └── lifecycle.js             # 生命周期管理
│   ├── events/                       # 全局事件监听器
│   │   ├── EventListenerManager.js  # 事件监听管理器
│   │   ├── InteractionListener.js   # 交互事件分发
│   │   ├── MemberListener.js        # 成员事件分发
│   │   └── MessageListener.js       # 消息事件分发
│   ├── middleware/                   # 中间件
│   │   ├── MiddlewareChain.js       # 中间件链管理
│   │   ├── defer.js                 # 自动defer交互
│   │   ├── usage.js                 # 使用场景验证
│   │   ├── usageValidators.js       # 使用场景验证器集合
│   │   ├── permissions.js           # 权限检查
│   │   ├── cooldown.js              # 冷却检查
│   │   └── errorHandler.js          # 统一错误处理
│   └── utils/                        # 核心工具
│       └── version.js               # 版本管理
│
├── infrastructure/                   # 基础设施
│   ├── database/                    # 数据库层
│   │   ├── DatabaseManager.js       # 统一数据库接口
│   │   ├── adapters/
│   │   │   ├── SqliteAdapter.js
│   │   │   └── PostgresAdapter.js
│   │   └── migrations/              # 迁移脚本
│   ├── api/                         # Discord API包装层
│   │   ├── ApiClient.js            # API调用包装
│   │   ├── RateLimiter.js          # 速率限制
│   │   ├── Monitor.js              # API调用监控
│   │   └── BatchProcessor.js       # 批量操作处理器
│   ├── monitoring/                   # 监控系统
│   │   ├── MonitoringManager.js     # 监控管理器
│   │   ├── ApiMonitor.js            # API调用监控
│   │   └── WebSocketMonitor.js      # WebSocket监控
│   ├── QueueManager.js              # 队列管理（基于p-queue）
│   ├── LockManager.js               # 锁管理（基于async-lock）
│   ├── SchedulerManager.js          # 调度管理（基于node-schedule）
│   └── CooldownManager.js            # 冷却管理
│
├── modules/                          # 业务模块
│   └── basic/                       # 基础模块（已实现）
│       ├── registries/              # 配置注册
│       │   └── commands.js         # Ping命令配置
│       ├── builders/                # 消息构建器
│       │   └── pingMessages.js     # Ping消息构建器
│       └── services/                # 业务服务
│           └── PingService.js      # Ping服务
│
├── shared/                           # 共享层
│   ├── factories/                   # Discord工厂函数
│   │   └── ComponentV2Factory.js   # Component V2构建器
│   ├── utils/                       # 通用工具
│   │   └── ErrorFormatter.js       # 错误格式化
│   ├── builders/                    # 共享构建器
│   ├── registries/                  # 共享注册
│   └── services/                    # 共享服务
│
├── tests/                            # 测试（待完善）
│   ├── unit/
│   └── integration/
│
├── scripts/                          # 脚本
│   └── [scripts]
│
├── docs/                             # 文档
│   └── USAGE_MIDDLEWARE.md         # 使用场景中间件文档
│
├── config/                           # 配置
│   ├── loader.js                    # 加载配置
│   ├── schema.js                    # 验证配置
│   ├── SETUP.md                     # 配置说明
│   ├── config.json                  # Bot全局配置（gitignore）
│   ├── guilds/                      # 服务器配置（gitignore）
│   │   └── {guildId}.json          # 各服务器独立配置
│   └── .env                         # 环境变量（gitignore）
│
├── index.js                          # 入口文件
├── plan.md                           # 架构设计文档
└── README.md                         # 项目说明
```

## 核心机制

### 1. 配置式注册

每个命令/按钮/modal/事件监听器都是一个配置对象。为保证易读性，我们约束所有配置遵循以下基础字段：

- `id`：模块内唯一 ID（必填）。
- `type`：`command` / `component` / `modal` / `event` / `task`（必填）。
- `inject`：需要容器注入的依赖（可选）。
- `middleware`：覆盖默认中间件链时才定义（可选）。
- `metadata`：任何非执行逻辑的附加信息（可选）。

**执行方法命名：**
- `execute`：主动触发（命令、定时任务）
- `handle`：响应式处理（组件交互、事件监听）

### 命令配置（Slash & Context）

```javascript
// modules/moderation/registries/commands.js
export default [
    {
        id: 'moderation.punish',
        type: 'command',
        commandKind: 'slash',          // 'slash' | 'userContext' | 'messageContext'
        name: '处罚',
        description: '对用户执行处罚',
        defer: true,                   // 可选
        ephemeral: true,               // 可选
        cooldown: 5_000,               // 可选，默认使用全局冷却
        permissions: ['moderator'],    // 可选
        inject: ['punishmentService'],
        builder(interactions) { /* 仅slash需要 */ },
        async execute(ctx, { punishmentService }) {
            await punishmentService.handle(ctx);
        }
    }
];
```

**注意**：配置文件必须导出数组，即使只有一个配置对象。

- Context 菜单命令将 `commandKind` 设为 `userContext` 或 `messageContext`，无需 `builder`，只保留 `name`。
- Registry 根据 `commandKind` 自动注册对应的 Application Command 类型，并在 Context 中挂载 `ctx.targetUser` / `ctx.targetMessage`。

### 组件配置（Button / Select / Modal）

**按钮配置示例：**
```javascript
// modules/moderation/registries/buttons.js
export default [
    {
        id: 'moderation.punishment.approve',
        type: 'component',
        componentKind: 'button',
        pattern: 'punishment_approve_{id}',
        defer: true,
        permissions: ['moderator'],
        inject: ['punishmentService'],
        async handle(ctx, params, { punishmentService }) {
            await punishmentService.approve(params.id);
        }
    },
    {
        id: 'moderation.punishment.reject',
        type: 'component',
        componentKind: 'button',
        pattern: 'punishment_reject_{id}',
        inject: ['punishmentService'],
        async handle(ctx, params, { punishmentService }) {
            await punishmentService.reject(params.id);
        }
    }
];
```

**Modal配置示例：**
```javascript
// modules/moderation/registries/modals.js
export default [
    {
        id: 'moderation.punishment.reason',
        type: 'modal',
        pattern: 'punishment_reason_{id}',
        inject: ['punishmentService'],
        async handle(ctx, params, { punishmentService }) {
            const reason = ctx.interaction.fields.getTextInputValue('reason');
            await punishmentService.updateReason(params.id, reason);
        }
    }
];
```

**Pattern 语法：**

用于匹配组件 customId 并提取参数：

- `{name}` - 匹配任意字符串
- `{id:int}` - 匹配整数并转换
- `{id:snowflake}` - 匹配Discord ID（17-19位数字）
- `{action:enum(approve,reject)}` - 枚举值
- `{name?}` - 可选参数

示例：`punishment_{action:enum(approve,reject)}_{id:snowflake}` 匹配 `punishment_approve_123456789012345678`

### 事件配置

```javascript
// modules/moderation/registries/events.js
export default [
    {
        id: 'moderation.guildMemberAdd',
        type: 'event',
        event: 'guildMemberAdd',
        once: false,
        priority: 10,                    // 可选，默认为 0
        inject: ['punishmentService'],
        filter(ctx) {
            return ctx.guild.id === ctx.config.targetGuildId;
        },
        async handle(ctx, { punishmentService }) {
            await punishmentService.auditMember(ctx.member);
        }
    }
];
```

- `priority`：优先级（默认0），数值越大越先执行
- `filter`：可选断言，返回`false`跳过执行
- `core/events/`统一监听Discord事件，触发时查询Registry并按优先级顺序执行所有处理器

### 定时任务配置

```javascript
// modules/moderation/registries/tasks.js
export default [
    {
        id: 'moderation.tasks.checkExpired',
        type: 'task',
        schedule: '*/5 * * * *',
        inject: ['punishmentService'],
        async execute({ punishmentService }) {
            await punishmentService.checkAndExpire();
        }
    }
];
```

### 2. 自动扫描与注册

**Registry流程：**
1. 扫描`modules/`目录下所有模块的`registries/`子目录
2. 加载`registries/`中的所有`.js`配置文件
3. 验证配置对象（必须包含`type`和`id`），失败的模块记录到diagnostics
4. 根据`type`分类注册到路由表，pattern编译为正则
5. 交互时匹配路由、提取参数、应用中间件、调用handler

**目录约定：**
- **仅扫描** `modules/[模块名]/registries/` 目录
- 其他目录（`services/`, `builders/`, `models/`, `utils/`）不会被扫描
- 配置文件必须导出配置对象或配置对象数组

**容错机制：**
- 配置校验失败不中断启动，记录到diagnostics
- 模块缺少`registries/`目录时自动跳过
- 清晰的错误日志便于定位问题

### 3. 依赖注入

**Container**：基于工厂函数的简单DI容器，仅支持singleton

**核心API：**
```javascript
class Container {
    register(name, factory)        // 注册服务工厂函数
    registerInstance(name, instance) // 直接注册实例
    get(name)                      // 获取服务实例（懒加载+缓存）
    has(name)                      // 检查服务是否存在
    resolve(dependencies)          // 批量解析依赖列表
}
```

**注册服务：**
```javascript
// bootstrap.js
// 注册基础设施
container.register('database', (c) => new DatabaseManager(c.get('config').database));
container.register('apiClient', (c) => new ApiClient({
    rateLimiter: c.get('rateLimiter'),
    monitor: c.get('monitor')
}));

// 注册业务服务（支持依赖注入）
container.register('punishmentService', (c) => new PunishmentService({
    database: c.get('database'),
    apiClient: c.get('apiClient'),
    logger: c.get('logger'),
    courtService: c.get('courtService')
}));

// 直接注册实例（用于配置等）
container.registerInstance('config', loadConfig());
```

**命令中使用：**
```javascript
export default {
    id: 'moderation.punish',
    inject: ['punishmentService', 'logger'],
    async execute(ctx, { punishmentService, logger }) {
        // 通过Registry自动注入依赖
        await punishmentService.execute(ctx);
    }
}
```

**服务间依赖：**
```javascript
class PunishmentService {
    constructor({ database, apiClient, courtService }) {
        this.db = database;
        this.api = apiClient;
        this.court = courtService;  // 通过容器自动解析
    }
}
```

**容错机制**：
- 运行时循环依赖检测（使用resolving Set追踪解析链）
- 启动时可选的依赖可解析性验证
- 清晰的错误提示（"Service xxx not found"、"Circular dependency detected"）

### 4. 中间件机制

**执行顺序：** errorHandler → defer → usage → permissions → cooldown → handler

**内置中间件：**

- **errorHandler**：包裹整个执行链，捕获错误并自动回复
  - 根据错误类型格式化消息（Discord API错误/业务错误/未知错误）
  - 自动处理 `interaction.reply/editReply`
  - 记录详细日志（基于Logger）

- **defer**：自动调用 `interaction.deferReply()`
  - 读取配置的 `defer` 字段：`true | { ephemeral: boolean }`
  - 跳过不支持defer的交互类型（autocomplete等）

- **usage**：使用场景验证
  - 读取配置的 `usage` 字段：`['inGuild', 'inThread']` 或对象形式
  - 验证交互环境（服务器/私信/线程/论坛等）和身份（线程主人/消息作者等）
  - 支持逻辑组合：`all`(AND)、`any`(OR)、`not`(NOT)
  - 不通过则返回具体错误提示并阻止执行
  - 详细文档：`docs/USAGE_MIDDLEWARE.md`

- **permissions**：权限检查
  - 读取配置的 `permissions` 字段：`['moderator', 'administrator']`
  - 从 `ctx.config` 和 `ctx.member.roles` 验证角色权限
  - 不通过则返回错误并阻止执行

- **cooldown**：冷却时间检查
  - 读取配置的 `cooldown` 字段（毫秒）
  - 使用 `CooldownManager` 存储最后执行时间
  - 冷却期内返回提示并阻止执行

**配置驱动**：
```javascript
export default {
    id: 'moderation.punish',
    defer: { ephemeral: true },
    usage: ['inGuild', 'inThread'],  // 使用场景验证
    permissions: ['moderator'],      // 角色权限验证
    cooldown: 5000,
    async execute(ctx) { /* 纯业务逻辑 */ }
}
```

### 5. 统一上下文对象

**Context（单层设计）：**

```javascript
class Context {
    /**
     * @param {Interaction} interaction - Discord交互对象
     * @param {Object} config - 服务器配置
     * @param {Container} container - 依赖注入容器
     */
    constructor(interaction, config, container = null) {
        // 核心对象
        this.interaction = interaction;
        this.client = interaction.client;
        this.config = config;
        this.container = container;

        // Discord快捷访问
        this.user = interaction.user;
        this.guild = interaction.guild;
        this.channel = interaction.channel;
        this.member = interaction.member;

        // 容器服务快捷访问
        this.logger = container?.get('logger');
        this.registry = container?.get('registry');

        // 上下文菜单额外字段
        if (interaction.isUserContextMenuCommand?.()) {
            this.targetUser = interaction.targetUser;
        }
        if (interaction.isMessageContextMenuCommand?.()) {
            this.targetMessage = interaction.targetMessage;
        }
    }

    /**
     * 统一回复（自动判断defer状态）
     */
    async reply(content) {
        const replyData = typeof content === 'string' ? { content } : content;
        if (this.interaction.deferred || this.interaction.replied) {
            return await this.interaction.editReply(replyData);
        }
        return await this.interaction.reply(replyData);
    }

    /**
     * 错误回复（默认使用ComponentV2）
     * @param {string} message - 错误消息
     * @param {boolean} useText - 是否使用纯文本（默认false）
     */
    async error(message, useText = false) {
        if (useText) {
            return await this.reply({
                content: `❌ ${message}`,
                flags: ['Ephemeral']
            });
        }

        // 动态导入避免循环依赖
        const { createErrorMessage } = await import('../shared/factories/ComponentV2Factory.js');
        const messageData = createErrorMessage('错误', message);
        messageData.flags = ['Ephemeral'];
        return await this.reply(messageData);
    }

    /**
     * 成功回复（默认使用ComponentV2）
     */
    async success(message, useText = false) {
        if (useText) {
            return await this.reply({ content: `✅ ${message}` });
        }

        const { createSuccessMessage } = await import('../shared/factories/ComponentV2Factory.js');
        return await this.reply(createSuccessMessage('成功', message));
    }

    /**
     * Defer回复
     */
    async defer(ephemeral = true) {
        if (!this.interaction.deferred && !this.interaction.replied) {
            await this.interaction.deferReply({
                flags: ephemeral ? ['Ephemeral'] : undefined
            });
        }
    }
}
```

**设计特点**：
- **解耦设计** - 直接传入config和container而非依赖client内部结构
- **快捷访问** - 自动挂载常用服务（logger、registry）和Discord对象
- **ComponentV2优先** - error/success默认使用ComponentV2，支持降级为纯文本
- **动态导入** - 避免循环依赖（模块会被Node.js缓存，性能影响可忽略）
- **上下文菜单支持** - 自动识别并挂载targetUser/targetMessage
- **单一职责** - 仅包装interaction和提供便捷方法，不承担业务逻辑

**可选的子类化**：
```javascript
// 如果需要为特定交互类型添加专属方法
class CommandContext extends Context {
    getOption(name) {
        return this.interaction.options.get(name);
    }
}
```

**注意**：动态import虽然有轻微开销，但优先考虑避免循环依赖。如ComponentV2Factory稳定后可改为静态import。

### 6. Discord API 统一包装层

**设计目标**：主动限速、全局监控、统一错误处理

**ApiClient**：包装所有Discord API调用
```javascript
// 单次调用
await apiClient.call('sendMessage', channel, { content: 'Hello' });
await apiClient.call('addRole', member, role);

// 批量调用
await apiClient.batch('removeMembers', members, {
    extractor: (m) => ({ thread, userId: m.id }),
    progressCallback: (current, total) => { /* 更新进度 */ }
});
```

**RateLimiter**：主动限速（基于Map）
- 路由识别：根据方法名和参数识别Discord路由（如 `POST /channels/{id}/messages`）
- 分层限速：全局限制 + 路由限制（从`config.json`读取）
- 主动等待：调用前检查，永不触发429

**Monitor**：API调用统计
- 记录：调用次数、响应时间、错误率、QPS
- 输出：结构化日志（基于Logger），便于分析瓶颈

**BatchProcessor**：批量操作处理
- 自动分组、并发控制、进度回调
- 基于ApiClient，自动应用限速策略

### 7. 队列与任务调度

**QueueManager**（基于p-queue）：控制任务并发和优先级

**职责分离：**
- **QueueManager**：任务并发数、优先级、超时（任务级别）
- **RateLimiter**：API调用频率、路由限速（API级别）

**使用示例：**
```javascript
// 添加高优先级任务
await queueManager.add(async () => {
    await punishmentService.execute(data);
}, { priority: 10 });

// 添加带锁的后台任务
await queueManager.addWithLock(async () => {
    await threadCleanup.process(thread);
}, {
    lockKey: `thread:${threadId}`,
    priority: 1
});
```

**配置（config.json）：**
```javascript
{
    "queue": {
        "concurrency": 3,
        "timeout": 900000,
        "priorities": {
            "high": 10,      // 交互命令
            "normal": 5,     // 普通任务
            "low": 1         // 后台任务
        }
    }
}
```

**特性**：
- 基于优先级调度
- 任务超时自动取消
- 支持pause/clear/onIdle事件
- 优雅关闭（等待运行中任务）

### 8. 配置系统设计

配置分为三层：环境变量、全局配置、服务器配置。

#### 配置文件

**1. .env（敏感环境变量）**
```bash
DISCORD_TOKEN=your_bot_token
DATABASE_URL=postgresql://user:pass@host:port/db  # 可选，留空则使用config.json配置
NODE_ENV=production
```

**2. config.json（全局配置，gitignore）**
```javascript
{
    "bot": {
        "clientId": "...",
        "logLevel": "info",
        "gracefulShutdownTimeout": 30000
    },
    "database": {
        "type": "postgres",  // 或 "sqlite"
        "postgres": {
            "host": "localhost",
            "port": 5432,
            "database": "gatekeeper",
            "user": "...",
            "password": "...",  // 优先使用DATABASE_URL
            "max": 20,
            "idleTimeoutMillis": 30000
        },
        "sqlite": { "path": "./data/database.sqlite" }
    },
    "api": {
        "rateLimit": {
            "global": { "maxRequests": 50, "window": 1000 },
            "routes": {
                "POST /channels/:id/messages": { "maxRequests": 5, "window": 1000 },
                "DELETE /guilds/:guildId/members/:userId": { "maxRequests": 1, "window": 1000 },
                "PUT /channels/:channelId/messages/:messageId/reactions/:emoji/@me": { "maxRequests": 1, "window": 250 }
            }
        },
        "monitor": { "enabled": true, "logInterval": 60000 }
    },
    "queue": {
        "concurrency": 3,
        "timeout": 900000,
        "priorities": { "high": 10, "normal": 5, "low": 1 }
    }
}
```

**3. guilds/{guildId}.json（服务器配置，gitignore）**

保持现有结构，从`config.json`的`guilds`字段迁移而来。

#### 配置加载

**Loader逻辑：**
1. 读取.env环境变量
2. 加载config.json（DATABASE_URL优先于配置文件）
3. 按需加载guilds/下的服务器配置
4. 使用AJV验证配置有效性
5. 注入到Container供全局使用

**配置访问：**
```javascript
// 通过ctx访问服务器配置
async execute(ctx) {
    const moderatorRoles = ctx.config.roleIds.moderators;
}

// 通过注入访问全局配置
class MyService {
    constructor(config) {
        this.apiConfig = config.api;
    }
}
```

### 9. 数据库统一接口

**Manager：**提供统一的`query()`, `get()`, `all()`, `run()`接口，根据配置自动选择SQLite/PostgreSQL adapter，集成缓存和慢查询日志

**Model：**继承BaseModel获得CRUD方法，声明schema（表名、字段、索引、缓存策略）

## 架构关键决策

### 1. 用成熟库替代homemade实现

- **p-queue** 替代自制RequestQueue：API更清晰，支持丰富事件
- **async-lock** 替代自制LockManager：支持读写锁、条件等待
- **pino** 替代简单logTime：结构化日志，性能更好
- 减少维护成本，提高可靠性

### 2. 简单DI容器

- **目的**：解决服务间依赖、便于测试、避免循环依赖
- **范围**：仅singleton作用域，不引入复杂生命周期
- **实现**：基础的register/resolve，支持依赖注入和循环检测

### 3. API包装层（主动限速）

- **ApiClient**：统一所有Discord API调用入口
- **RateLimiter**：主动限速，永不触发429错误
- **Monitor**：记录调用统计，便于性能分析
- **收益**：可靠性提升，问题可追溯

### 4. 配置驱动的中间件

- 将defer/permissions/cooldown从代码逻辑抽取为配置字段
- 减少重复代码，统一处理流程
- 便于扩展和维护

### 5. 配置迁移路径

1. `config.json`的`token`移到`.env`
2. `guilds`对象拆分为`guilds/{guildId}.json`
3. 数据库、API、队列配置整合到`config.json`根级别

## 引入的外部依赖

- **p-queue** (^8.0.1)：任务队列与并发控制
- **async-lock** (^1.4.1)：锁管理（支持读写锁、条件等待）
- **node-schedule** (^2.1.1)：定时任务调度
- **pino** (^8.16.0)：结构化日志（JSON格式，高性能）
- **pino-pretty** (^10.2.0)：开发环境日志美化
- **dotenv** (^16.3.1)：环境变量加载

**不引入的库**：
- ❌ lru-cache：冷却管理用Map即可
- ❌ ajv：配置验证用简单函数更清晰
