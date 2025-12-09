# jsbot 重写指南

从零开始重写 jsbot 框架的完整指南。

---

## 一、设计原则

### 核心理念

1. **配置驱动** - 命令/组件是配置对象，非类
2. **最小内核** - 内核只做连接和路由，不做业务
3. **tsyringe DI** - 服务用装饰器，类型安全
4. **直接 discord.js** - 不过度包装
5. **热重载** - 模块可运行时替换

### 重要约定

1. **Database 抽象** - database 服务只保留基本抽象（连接管理、适配器接口），具体的表定义和 db 类型放在各业务模块中，避免内核耦合业务数据结构

2. **配置文件分离** - 实际运行时的配置文件（如 `config.json`、`.env` 等）必须放在 `src/` 目录外（如项目根目录的 `config/`），避免配置与源码混合

3. **消除 shared 冗余** - 现有 `shared/` 目录内容应按职责重新归类：
   - `ConfirmationService` + `ConfirmationMessageBuilder` → `services/Confirmation.ts`（合并为确认服务）
   - `ComponentV2Factory` → `services/ComponentFactory.ts`（Discord UI 组件工厂）
   - `ErrorFormatter` → `services/ErrorFormatter.ts`（错误格式化工具）
   - `confirmationButtons.js`（按钮注册）→ 作为框架内置组件放入 `modules/core/components/`

### Context 设计：最小核心

```typescript
// Context 只提供最基础的能力
interface Context<T extends Interaction = Interaction> {
    readonly interaction: T;
    readonly config: GuildConfig;
    resolve<S>(token: InjectionToken<S>): S;
}

// 便捷方法通过服务提供
const reply = ctx.resolve(ReplyService);
await reply.success('操作成功');

// 或直接用 discord.js
await ctx.interaction.reply({ content: '...' });
```

---

## 二、目录结构

```
project-root/
├── config/                  # 运行时配置（src 外部）
│   ├── config.json         # 主配置文件
│   ├── guilds/             # 服务器配置
│   └── .env                # 环境变量
│
├── src/
│   ├── index.ts            # 入口
│   │
│   ├── kernel/             # 内核（稳定层）
│   │   ├── index.ts        # 导出内核 API
│   │   ├── Application.ts  # 应用生命周期
│   │   ├── Registry.ts     # 配置注册 + 路由
│   │   ├── Context.ts      # 最小上下文
│   │   ├── Pattern.ts      # pattern → regex
│   │   ├── Pipeline.ts     # 中间件管道
│   │   └── ModuleLoader.ts # 模块加载/卸载/热重载
│   │
│   ├── services/           # 框架服务（tsyringe）
│   │   ├── index.ts        # 导出 + TOKENS
│   │   ├── Logger.ts
│   │   ├── ConfigManager.ts
│   │   ├── Queue.ts
│   │   ├── Lock.ts
│   │   ├── Cooldown.ts
│   │   ├── Scheduler.ts
│   │   ├── Reply.ts        # 回复服务（success/error/info）
│   │   └── database/
│   │       ├── Database.ts # 仅基本抽象（连接、适配器接口）
│   │       └── adapters/   # 数据库适配器
│   │
│   ├── middleware/         # 内置中间件
│   │   ├── index.ts
│   │   ├── defer.ts
│   │   ├── usage.ts
│   │   ├── permissions.ts
│   │   ├── cooldown.ts
│   │   └── queue.ts
│   │
│   ├── validators/         # usage 验证器
│   │   ├── index.ts
│   │   ├── environment.ts  # inGuild, inThread...
│   │   └── identity.ts     # isThreadOwner...
│   │
│   ├── listeners/          # Discord 事件监听
│   │   ├── index.ts
│   │   ├── interaction.ts
│   │   ├── member.ts
│   │   └── message.ts
│   │
│   ├── config/             # 配置加载逻辑（非配置文件本身）
│   │   ├── loader.ts       # 从 project-root/config/ 加载
│   │   └── schema.ts       # Zod schemas
│   │
│   ├── types/              # 仅放配置类型定义
│   │   ├── config.ts       # CommandConfig, ButtonConfig...
│   │   └── index.ts
│   │
│   └── modules/            # 业务模块（用户编写）
│       ├── basic/          # 示例模块
│       │   ├── commands/
│       │   │   └── system.ts
│       │   ├── components/
│       │   ├── services/
│       │   │   └── System.ts
│       │   └── db/         # 模块专属表定义（如需要）
│       └── [其他模块]/
│
└── package.json
```

### 目录职责说明

| 目录 | 职责 | 稳定性 |
|-----|------|--------|
| `config/`（根目录） | 运行时配置文件 | 低，按环境变化 |
| `src/kernel/` | 框架核心机制 | 极高，几乎不改 |
| `src/services/` | 框架提供的服务 | 高，接口稳定 |
| `src/middleware/` | 内置中间件 | 高，可扩展 |
| `src/validators/` | usage 验证器 | 中，可扩展 |
| `src/listeners/` | 事件监听分发 | 高 |
| `src/config/` | 配置加载逻辑 | 高 |
| `src/types/` | 配置类型定义 | 中，随功能扩展 |
| `src/modules/` | 业务代码 | 低，频繁变化 |

> **注意**：不存在 `shared/` 目录。原 shared 中的通用逻辑应根据职责归入 `kernel/` 或 `services/`。

---

## 三、内核设计

### 3.1 Application.ts

```typescript
// kernel/Application.ts
import { Client, GatewayIntentBits } from 'discord.js';
import { container } from 'tsyringe';
import { Registry } from './Registry.js';
import { ModuleLoader } from './ModuleLoader.js';

export class Application {
    private client: Client;
    private registry: Registry;
    private moduleLoader: ModuleLoader;

    async start(): Promise<void> {
        // 1. 初始化 DI 容器（服务注册在 services/index.ts）
        await import('../services/index.js');

        // 2. 创建 Discord Client
        this.client = new Client({ intents: [...] });
        container.registerInstance('Client', this.client);

        // 3. 初始化内核组件
        this.registry = container.resolve(Registry);
        this.moduleLoader = container.resolve(ModuleLoader);

        // 4. 加载模块
        await this.moduleLoader.loadAll('./src/modules');

        // 5. 注册事件监听
        await import('../listeners/index.js');

        // 6. 连接 Discord
        await this.client.login(process.env.DISCORD_TOKEN);
    }

    async stop(): Promise<void> {
        // 优雅关闭
    }
}
```

### 3.2 Registry.ts

```typescript
// kernel/Registry.ts
import { injectable } from 'tsyringe';
import { Pattern } from './Pattern.js';

@injectable()
export class Registry {
    private commands = new Map<string, CommandConfig>();
    private buttons = new Map<string, CompiledRoute>();
    private modals = new Map<string, CompiledRoute>();
    private events = new Map<string, EventConfig[]>();

    register(config: AnyConfig): void {
        switch (config.type) {
            case 'command':
            case 'commandGroup':
                this.registerCommand(config);
                break;
            case 'button':
                this.registerButton(config);
                break;
            // ...
        }
    }

    private registerButton(config: ButtonConfig): void {
        const compiled = Pattern.compile(config.pattern);
        this.buttons.set(config.id, { config, ...compiled });
    }

    findCommand(name: string, subcommand?: string): CommandConfig | null { ... }
    findButton(customId: string): RouteMatch | null { ... }
    findModal(customId: string): RouteMatch | null { ... }

    // 热重载支持
    unregisterByModule(moduleName: string): void {
        // 移除该模块的所有配置
    }
}
```

### 3.3 Context.ts（最小核心）

```typescript
// kernel/Context.ts
import { Interaction } from 'discord.js';
import { DependencyContainer, InjectionToken } from 'tsyringe';

export class Context<T extends Interaction = Interaction> {
    constructor(
        public readonly interaction: T,
        public readonly config: GuildConfig,
        private readonly container: DependencyContainer
    ) {}

    resolve<S>(token: InjectionToken<S>): S {
        return this.container.resolve(token);
    }

    // 类型安全的交互访问
    get user() { return this.interaction.user; }
    get guild() { return this.interaction.guild; }
    get channel() { return this.interaction.channel; }
    get member() { return this.interaction.member as GuildMember | null; }
}

// 特化 Context 类型
export type CommandContext = Context<ChatInputCommandInteraction>;
export type ButtonContext = Context<ButtonInteraction>;
export type ModalContext = Context<ModalSubmitInteraction>;
// ...
```

### 3.4 Pattern.ts

```typescript
// kernel/Pattern.ts
export interface CompiledPattern {
    regex: RegExp;
    params: ParamInfo[];
    extract(input: string): Record<string, unknown> | null;
}

export class Pattern {
    static compile(pattern: string): CompiledPattern {
        const params: ParamInfo[] = [];

        const regexStr = pattern.replace(/\{([^}]+)\}/g, (_, param) => {
            const { name, type, optional } = parseParam(param);
            params.push({ name, type, optional });
            return buildRegexPart(type, optional);
        });

        const regex = new RegExp(`^${regexStr}$`);

        return {
            regex,
            params,
            extract(input: string) {
                const match = input.match(regex);
                if (!match) return null;
                return extractParams(match, params);
            }
        };
    }
}
```

### 3.5 Pipeline.ts（中间件管道）

```typescript
// kernel/Pipeline.ts
export type Next = () => Promise<void>;
export type Middleware = (ctx: Context, next: Next, config: AnyConfig) => Promise<void>;

export class Pipeline {
    private middlewares: Middleware[] = [];

    use(middleware: Middleware): this {
        this.middlewares.push(middleware);
        return this;
    }

    async execute(ctx: Context, config: AnyConfig, handler: () => Promise<void>): Promise<void> {
        let index = 0;

        const next: Next = async () => {
            if (index < this.middlewares.length) {
                const mw = this.middlewares[index++];
                await mw(ctx, next, config);
            } else {
                await handler();
            }
        };

        await next();
    }
}
```

### 3.6 ModuleLoader.ts

```typescript
// kernel/ModuleLoader.ts
import { injectable, inject } from 'tsyringe';
import { Registry } from './Registry.js';

@injectable()
export class ModuleLoader {
    private loadedModules = new Set<string>();

    constructor(
        @inject(Registry) private registry: Registry,
        @inject('Logger') private logger: Logger
    ) {}

    async loadAll(modulesPath: string): Promise<void> {
        const modules = await this.scanModules(modulesPath);
        for (const mod of modules) {
            await this.load(mod);
        }
    }

    async load(moduleName: string): Promise<void> {
        // 加载 commands/, components/, events/, services/
        // 注册到 Registry 和 tsyringe
    }

    async reload(moduleName: string): Promise<void> {
        await this.unload(moduleName);
        await this.load(moduleName);
    }

    async unload(moduleName: string): Promise<void> {
        this.registry.unregisterByModule(moduleName);
        // 清理 tsyringe 中该模块的服务
    }
}
```

---

## 四、服务层设计

### 4.1 服务注册（services/index.ts）

```typescript
// services/index.ts
import 'reflect-metadata';
import { container } from 'tsyringe';

// 导入所有服务（装饰器自动注册）
import { Logger } from './Logger.js';
import { ConfigManager } from './ConfigManager.js';
import { Queue } from './Queue.js';
import { Lock } from './Lock.js';
import { Cooldown } from './Cooldown.js';
import { Scheduler } from './Scheduler.js';
import { Reply } from './Reply.js';
import { Database } from './database/Database.js';

// TOKENS（用于非类依赖或接口）
export const TOKENS = {
    Logger: Symbol('Logger'),
    Config: Symbol('Config'),
    GuildConfig: Symbol('GuildConfig'),
} as const;

// 注册配置实例
import { loadConfig } from '../config/loader.js';
const config = await loadConfig();
container.registerInstance(TOKENS.Config, config);

// 导出服务类型
export { Logger, ConfigManager, Queue, Lock, Cooldown, Scheduler, Reply, Database };
```

### 4.2 服务示例

```typescript
// services/Logger.ts
import { injectable, singleton } from 'tsyringe';
import pino from 'pino';

@injectable()
@singleton()
export class Logger {
    private pino: pino.Logger;

    constructor() {
        this.pino = pino({ /* config */ });
    }

    info(msg: string, data?: object): void { ... }
    error(msg: string, data?: object): void { ... }
    debug(msg: string, data?: object): void { ... }
}
```

```typescript
// services/Reply.ts
import { injectable } from 'tsyringe';
import { Message, InteractionResponse } from 'discord.js';

@injectable()
export class Reply {
    async success(interaction: RepliableInteraction, message: string): Promise<Message> {
        return this.send(interaction, { content: `✅ ${message}` });
    }

    async error(interaction: RepliableInteraction, message: string): Promise<Message> {
        return this.send(interaction, {
            content: `❌ ${message}`,
            flags: ['Ephemeral']
        });
    }

    private async send(interaction: RepliableInteraction, data: MessagePayload): Promise<Message> {
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply(data);
        }
        return interaction.reply(data);
    }
}
```

```typescript
// services/Queue.ts
import { injectable, singleton, inject } from 'tsyringe';
import PQueue from 'p-queue';
import { Logger } from './Logger.js';

@injectable()
@singleton()
export class Queue {
    private queue: PQueue;

    constructor(@inject(Logger) private logger: Logger) {
        this.queue = new PQueue({ concurrency: 3 });
    }

    async add<T>(task: () => Promise<T>, options?: QueueOptions): Promise<T> {
        return this.queue.add(task, { priority: options?.priority });
    }
}
```

### 4.3 Database 服务（仅基本抽象）

Database 服务只提供连接管理和适配器接口，**不定义具体的表结构**。具体的表定义由各业务模块自行管理。

```typescript
// services/database/Database.ts
import { injectable, singleton } from 'tsyringe';

// 适配器接口（抽象）
export interface DatabaseAdapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    getClient(): unknown;  // 返回原始客户端（drizzle db 实例等）
}

@injectable()
@singleton()
export class Database {
    private adapter: DatabaseAdapter | null = null;

    async initialize(adapter: DatabaseAdapter): Promise<void> {
        this.adapter = adapter;
        await this.adapter.connect();
    }

    getAdapter(): DatabaseAdapter {
        if (!this.adapter) throw new Error('Database not initialized');
        return this.adapter;
    }

    async shutdown(): Promise<void> {
        await this.adapter?.disconnect();
    }
}
```

```typescript
// 业务模块中定义表结构
// modules/moderation/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const warnings = sqliteTable('warnings', {
    id: integer('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
});

// modules/moderation/db/index.ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Database } from '../../../services/database/Database.js';
import * as schema from './schema.js';

export function getModerationDb(database: Database) {
    const adapter = database.getAdapter();
    return drizzle(adapter.getClient(), { schema });
}
```

---

## 五、配置类型定义

### types/config.ts

```typescript
// types/config.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

// ===== 基础配置 =====
export interface BaseConfig {
    id: string;
    type: ConfigType;
    defer?: boolean | { ephemeral: boolean };
    usage?: UsageConstraint;
    permissions?: string[];
    cooldown?: number;
}

// ===== 命令配置 =====
export interface CommandConfig extends BaseConfig {
    type: 'command';
    commandKind: 'slash' | 'userContext' | 'messageContext';
    name: string;
    description?: string;
    builder?: () => SlashCommandBuilder;
    execute: (ctx: CommandContext) => Promise<void>;
    autocomplete?: (ctx: AutocompleteContext) => Promise<void>;
}

export interface SubcommandConfig {
    id: string;
    name: string;
    cooldown?: number;
    execute: (ctx: CommandContext) => Promise<void>;
    autocomplete?: (ctx: AutocompleteContext) => Promise<void>;
}

export interface CommandGroupConfig extends BaseConfig {
    type: 'commandGroup';
    commandKind: 'slash';
    name: string;
    description: string;
    shared?: Partial<BaseConfig>;
    builder: () => SlashCommandBuilder;
    subcommands: SubcommandConfig[];
}

// ===== 组件配置 =====
export interface ButtonConfig extends BaseConfig {
    type: 'button';
    pattern: string;
    handle: (ctx: ButtonContext, params: Record<string, unknown>) => Promise<void>;
}

export interface SelectMenuConfig extends BaseConfig {
    type: 'selectMenu';
    pattern: string;
    handle: (ctx: SelectMenuContext, params: Record<string, unknown>) => Promise<void>;
}

export interface ModalConfig extends BaseConfig {
    type: 'modal';
    pattern: string;
    handle: (ctx: ModalContext, params: Record<string, unknown>) => Promise<void>;
}

// ===== 事件配置 =====
export interface EventConfig extends BaseConfig {
    type: 'event';
    event: DiscordEvent;
    once?: boolean;
    priority?: number;
    filter?: (ctx: Context) => boolean;
    handle: (ctx: Context) => Promise<void>;
}

// ===== 任务配置 =====
export interface TaskConfig {
    id: string;
    type: 'task';
    schedule: string;  // cron
    execute: () => Promise<void>;
}

// ===== 联合类型 =====
export type AnyConfig =
    | CommandConfig
    | CommandGroupConfig
    | ButtonConfig
    | SelectMenuConfig
    | ModalConfig
    | EventConfig
    | TaskConfig;
```

---

## 六、模块结构

### 6.1 模块目录结构

```
modules/basic/
├── commands/
│   ├── ping.ts
│   └── system.ts      # 命令组
├── components/
│   └── confirm.ts     # 按钮
├── events/
│   └── ready.ts
└── services/
    └── System.ts      # 业务服务
```

### 6.2 命令配置示例

```typescript
// modules/basic/commands/system.ts
import { SlashCommandBuilder } from 'discord.js';
import { CommandGroupConfig } from '../../../types/config.js';
import { System } from '../services/System.js';

export default {
    id: 'basic.system',
    type: 'commandGroup',
    commandKind: 'slash',
    name: '系统',
    description: 'Bot 系统管理',

    shared: {
        defer: { ephemeral: true },
        usage: ['inGuild'],
        permissions: ['administrator'],
    },

    builder() {
        return new SlashCommandBuilder()
            .setName(this.name)
            .setDescription(this.description)
            .addSubcommand(sub =>
                sub.setName('同步指令').setDescription('同步 Discord 指令')
            )
            .addSubcommand(sub =>
                sub.setName('重载模块')
                    .setDescription('热重载模块')
                    .addStringOption(opt =>
                        opt.setName('模块').setRequired(true).setAutocomplete(true)
                    )
            );
    },

    subcommands: [
        {
            id: 'sync',
            name: '同步指令',
            cooldown: 10000,
            async execute(ctx) {
                const system = ctx.resolve(System);
                await system.syncCommands(ctx);
            }
        },
        {
            id: 'reload',
            name: '重载模块',
            cooldown: 5000,
            async autocomplete(ctx) {
                const system = ctx.resolve(System);
                await system.autocompleteModules(ctx);
            },
            async execute(ctx) {
                const system = ctx.resolve(System);
                await system.reloadModule(ctx);
            }
        }
    ]
} satisfies CommandGroupConfig;
```

### 6.3 组件配置示例

```typescript
// modules/basic/components/confirm.ts
import { ButtonConfig } from '../../../types/config.js';
import { Reply } from '../../../services/Reply.js';

export default {
    id: 'basic.confirm',
    type: 'button',
    pattern: 'confirm_{action:enum(yes,no)}_{id:snowflake}',
    defer: true,

    async handle(ctx, params) {
        const reply = ctx.resolve(Reply);

        if (params.action === 'yes') {
            await reply.success(ctx.interaction, '已确认');
        } else {
            await reply.error(ctx.interaction, '已取消');
        }
    }
} satisfies ButtonConfig;
```

### 6.4 业务服务示例

```typescript
// modules/basic/services/System.ts
import { injectable, inject } from 'tsyringe';
import { Logger } from '../../../services/Logger.js';
import { ModuleLoader } from '../../../kernel/ModuleLoader.js';
import { CommandContext, AutocompleteContext } from '../../../kernel/Context.js';
import { Reply } from '../../../services/Reply.js';

@injectable()
export class System {
    constructor(
        @inject(Logger) private logger: Logger,
        @inject(ModuleLoader) private moduleLoader: ModuleLoader,
        @inject(Reply) private reply: Reply
    ) {}

    async syncCommands(ctx: CommandContext): Promise<void> {
        // 实现...
        await this.reply.success(ctx.interaction, '指令同步完成');
    }

    async reloadModule(ctx: CommandContext): Promise<void> {
        const moduleName = ctx.interaction.options.getString('模块', true);

        try {
            await this.moduleLoader.reload(moduleName);
            await this.reply.success(ctx.interaction, `模块 ${moduleName} 重载成功`);
        } catch (e) {
            await this.reply.error(ctx.interaction, `重载失败: ${e.message}`);
        }
    }

    async autocompleteModules(ctx: AutocompleteContext): Promise<void> {
        const modules = await this.moduleLoader.getLoadedModules();
        await ctx.interaction.respond(
            modules.map(m => ({ name: m, value: m }))
        );
    }
}
```

---

## 七、中间件实现

### 7.1 中间件注册

```typescript
// middleware/index.ts
import { Pipeline } from '../kernel/Pipeline.js';
import { deferMiddleware } from './defer.js';
import { usageMiddleware } from './usage.js';
import { permissionsMiddleware } from './permissions.js';
import { cooldownMiddleware } from './cooldown.js';
import { queueMiddleware } from './queue.js';

export function createPipeline(): Pipeline {
    return new Pipeline()
        .use(deferMiddleware)
        .use(usageMiddleware)
        .use(permissionsMiddleware)
        .use(cooldownMiddleware)
        .use(queueMiddleware);
}

// 顺序: defer → usage → permissions → cooldown → queue → handler
```

### 7.2 中间件示例

```typescript
// middleware/defer.ts
import { Middleware } from '../kernel/Pipeline.js';

export const deferMiddleware: Middleware = async (ctx, next, config) => {
    if (config.defer && 'deferReply' in ctx.interaction) {
        const ephemeral = typeof config.defer === 'object'
            ? config.defer.ephemeral
            : false;
        await ctx.interaction.deferReply({ ephemeral });
    }
    await next();
};
```

```typescript
// middleware/cooldown.ts
import { container } from 'tsyringe';
import { Middleware } from '../kernel/Pipeline.js';
import { Cooldown } from '../services/Cooldown.js';
import { Reply } from '../services/Reply.js';

export const cooldownMiddleware: Middleware = async (ctx, next, config) => {
    if (!config.cooldown) {
        return next();
    }

    const cooldown = container.resolve(Cooldown);
    const result = cooldown.check(ctx.user.id, config.id, config.cooldown);

    if (!result.allowed) {
        const reply = container.resolve(Reply);
        await reply.error(
            ctx.interaction,
            `请等待 ${Math.ceil(result.remaining / 1000)} 秒`
        );
        return;
    }

    await next();
};
```

---

## 八、事件监听

```typescript
// listeners/interaction.ts
import { container } from 'tsyringe';
import { Events } from 'discord.js';
import { Registry } from '../kernel/Registry.js';
import { Context } from '../kernel/Context.js';
import { createPipeline } from '../middleware/index.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { Logger } from '../services/Logger.js';

export function setupInteractionListener(client: Client): void {
    const registry = container.resolve(Registry);
    const configManager = container.resolve(ConfigManager);
    const logger = container.resolve(Logger);
    const pipeline = createPipeline();

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            const guildConfig = configManager.getGuild(interaction.guildId);
            const ctx = new Context(interaction, guildConfig, container);

            if (interaction.isChatInputCommand()) {
                const config = registry.findCommand(
                    interaction.commandName,
                    interaction.options.getSubcommand(false)
                );
                if (!config) return;

                await pipeline.execute(ctx, config, () => config.execute(ctx));
            }

            if (interaction.isButton()) {
                const match = registry.findButton(interaction.customId);
                if (!match) return;

                await pipeline.execute(ctx, match.config, () =>
                    match.config.handle(ctx, match.params)
                );
            }

            // Modal, SelectMenu 类似...

        } catch (error) {
            logger.error('Interaction error', { error });
        }
    });
}
```

---

## 九、开发规范

### 9.1 类型安全

```typescript
// ✅ 正确：类型从实现推断
export class MyService { ... }
export type { MyService };

// ❌ 错误：独立接口文件
export interface IMyService { ... }
```

### 9.2 依赖注入

```typescript
// ✅ 正确：tsyringe 装饰器
@injectable()
export class MyService {
    constructor(@inject(Logger) private logger: Logger) {}
}

// ❌ 错误：手动赋值
export class MyService {
    constructor(deps: Record<string, unknown>) {
        this.logger = deps.logger as Logger;
    }
}
```

### 9.3 配置定义

```typescript
// ✅ 正确：satisfies 检查
export default { ... } satisfies CommandConfig;

// ❌ 错误：类型注解
const config: CommandConfig = { ... };
```

### 9.4 Discord API 调用

```typescript
// ✅ 正确：直接用 discord.js
await ctx.interaction.reply({ content: '...' });
await channel.send({ content: '...' });

// ❌ 错误：包装每个 API 方法
await apiClient.call('sendMessage', channel, options);
```

---

## 十、文件清单

### 必须实现

| 文件 | 职责 |
|-----|------|
| `kernel/Application.ts` | 应用入口 |
| `kernel/Registry.ts` | 配置注册 + 路由 |
| `kernel/Context.ts` | 最小上下文 |
| `kernel/Pattern.ts` | pattern 编译 |
| `kernel/Pipeline.ts` | 中间件管道 |
| `kernel/ModuleLoader.ts` | 模块加载 |
| `services/index.ts` | 服务注册 + TOKENS |
| `services/Logger.ts` | 日志服务 |
| `services/Reply.ts` | 回复服务 |
| `middleware/defer.ts` | defer 中间件 |
| `middleware/usage.ts` | usage 中间件 |
| `middleware/permissions.ts` | 权限中间件 |
| `middleware/cooldown.ts` | 冷却中间件 |
| `listeners/interaction.ts` | 交互监听 |
| `types/config.ts` | 配置类型 |
| `config/schema.ts` | Zod schemas |

### 可选实现

| 文件 | 职责 |
|-----|------|
| `services/Queue.ts` | 任务队列 |
| `services/Lock.ts` | 锁管理 |
| `services/Scheduler.ts` | 定时任务 |
| `services/database/Database.ts` | 数据库抽象（仅连接管理） |
| `services/database/adapters/*` | 数据库适配器 |
| `middleware/queue.ts` | 队列中间件 |
| `listeners/member.ts` | 成员事件 |
| `listeners/message.ts` | 消息事件 |

> **注意**：`services/database/` 只包含连接管理和适配器接口。具体的表定义（schema）应放在使用它的业务模块的 `db/` 子目录中。

---

## 十一、与旧架构对比

| 方面 | 旧架构 | 新架构 |
|-----|-------|-------|
| DI | 手写 Container | tsyringe |
| Context | 包含 reply/error 等方法 | 最小核心，服务提供便捷方法 |
| ApiClient | 59 个方法封装 | 不存在，直接用 discord.js |
| types/ | 299 行接口定义 | 仅配置类型，服务类型从实现推断 |
| 中间件 | 分散在各处 | 独立 middleware/ 目录 |
| 模块目录 | registries/services/ | commands/components/services/ |
| shared/ | 混杂 services/builders/factories/utils | 不存在，归入 services/ 或 modules/core/ |
| 配置文件 | 在 src/ 内 | 在项目根目录 config/（src 外） |
| database | 包含表定义 | 仅抽象，表定义在业务模块中 |

---

## 十二、成功标准

```
代码量 < 5,000 行（不含 modules/）
as any = 0
热重载正常
类型 100% 覆盖
```
