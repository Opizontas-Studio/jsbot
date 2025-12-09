/**
 * 应用生命周期管理
 * @module kernel/Application
 */

import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import 'reflect-metadata';
import { container, DependencyContainer } from 'tsyringe';
import type { AppConfig } from '../types/config.js';
import type { Context } from './Context.js';
import { LOGGER_TOKEN, ModuleLoader, type ILogger } from './ModuleLoader.js';
import { Pipeline, type Middleware } from './Pipeline.js';
import { Registry } from './Registry.js';

// 类型导出
export const TOKENS = {
    Client: Symbol('Client'),
    Config: Symbol('Config'),
    Logger: Symbol('Logger'),
    Registry: Symbol('Registry'),
    ModuleLoader: Symbol('ModuleLoader'),
    Pipeline: Symbol('Pipeline')
} as const;

export interface ApplicationOptions {
    config: AppConfig;
    intents?: GatewayIntentBits[];
    partials?: Partials[];
    modulesPath?: string;
}

export interface ShutdownHook {
    name: string;
    priority: number;
    handler: () => Promise<void>;
}

// intents
const DEFAULT_INTENTS = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
];

const DEFAULT_PARTIALS = [Partials.Channel, Partials.Message, Partials.GuildMember];

// 主应用类
export class Application {
    // 属性
    private client: Client | null = null;
    private registry: Registry | null = null;
    private moduleLoader: ModuleLoader | null = null;
    private pipeline: Pipeline | null = null;
    private logger: ILogger | null = null;
    private shutdownHooks: ShutdownHook[] = [];
    private isShuttingDown = false;

    readonly container: DependencyContainer;
    private readonly config: AppConfig;
    private readonly intents: GatewayIntentBits[];
    private readonly partials: Partials[];
    private readonly modulesPath: string;

    constructor(options: ApplicationOptions) {
        this.config = options.config;
        this.intents = options.intents ?? DEFAULT_INTENTS;
        this.partials = options.partials ?? DEFAULT_PARTIALS;
        this.modulesPath = options.modulesPath ?? './src/modules';
        this.container = container.createChildContainer();
    }

    // 初始化
    async initialize(): Promise<void> {
        this.container.registerInstance(TOKENS.Config, this.config);

        if (!this.container.isRegistered(TOKENS.Logger)) {
            this.container.registerInstance(TOKENS.Logger, createConsoleLogger());
        }
        this.logger = this.container.resolve<ILogger>(TOKENS.Logger);
        this.logger.info('Initializing...');

        this.client = new Client({ intents: this.intents, partials: this.partials });
        this.container.registerInstance(TOKENS.Client, this.client);

        this.container.register(Registry, { useClass: Registry });
        this.registry = this.container.resolve(Registry);
        this.container.registerInstance(TOKENS.Registry, this.registry);

        this.pipeline = new Pipeline();
        this.container.registerInstance(TOKENS.Pipeline, this.pipeline);

        this.container.register(LOGGER_TOKEN, { useToken: TOKENS.Logger });
        this.container.register(ModuleLoader, { useClass: ModuleLoader });
        this.moduleLoader = this.container.resolve(ModuleLoader);
        this.container.registerInstance(TOKENS.ModuleLoader, this.moduleLoader);

        await this.initializeServices();
        this.logger.info('Initialized');
    }

    // 启动
    async start(): Promise<void> {
        this.assertInitialized();
        this.logger!.info('Starting...');

        await this.moduleLoader!.loadAll(this.modulesPath);
        await this.setupEventListeners();

        const token = process.env.DISCORD_TOKEN;
        if (!token) throw new Error('DISCORD_TOKEN required');

        await this.client!.login(token);
        await this.waitForReady();
        await this.deployCommands();

        this.logger!.info('Started', { user: this.client!.user?.tag, guilds: this.client!.guilds.cache.size });
    }

    // 停止
    async stop(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.logger?.info('Stopping...');

        for (const hook of [...this.shutdownHooks].sort((a, b) => b.priority - a.priority)) {
            try {
                await Promise.race([
                    hook.handler(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Timeout')), this.config.bot.gracefulShutdownTimeout / 2)
                    )
                ]);
            } catch (e) {
                this.logger?.error(`Hook "${hook.name}" failed`, { error: String(e) });
            }
        }

        this.client?.destroy();
        this.client = null;
        this.logger?.info('Stopped');
    }

    getClient(): Client {
        this.assertInitialized();
        return this.client!;
    }

    getRegistry(): Registry {
        this.assertInitialized();
        return this.registry!;
    }

    getModuleLoader(): ModuleLoader {
        this.assertInitialized();
        return this.moduleLoader!;
    }

    getPipeline(): Pipeline {
        this.assertInitialized();
        return this.pipeline!;
    }

    use(middleware: Middleware<Context>, name?: string): this {
        this.getPipeline().use(middleware, name);
        return this;
    }

    onShutdown(name: string, handler: () => Promise<void>, priority = 0): void {
        this.shutdownHooks.push({ name, handler, priority });
    }

    setupGracefulShutdown(): void {
        const shutdown = async (signal: string) => {
            this.logger?.info(`Received ${signal}`);
            await this.stop();
            process.exit(0);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }

    protected async initializeServices(): Promise<void> {}
    protected async setupEventListeners(): Promise<void> {}

    private assertInitialized(): void {
        if (!this.client || !this.registry || !this.moduleLoader || !this.pipeline) {
            throw new Error('Not initialized');
        }
    }

    private waitForReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.client!.isReady()) return resolve();
            const timeout = setTimeout(() => reject(new Error('Ready timeout')), 30000);
            this.client!.once(Events.ClientReady, () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    private async deployCommands(): Promise<void> {
        const token = process.env.DISCORD_TOKEN;
        const clientId = process.env.DISCORD_CLIENT_ID ?? this.client!.user?.id;
        if (!token || !clientId) {
            this.logger?.warn('Cannot deploy: missing token/clientId');
            return;
        }

        const commands = this.registry!.getAllCommands();
        const data = commands
            .filter(c => c.builder)
            .map(c => {
                const builder = c.builder as (this: typeof c) => { toJSON(): unknown };
                return builder.call(c).toJSON();
            });

        if (data.length === 0) return;

        try {
            await new REST().setToken(token).put(Routes.applicationCommands(clientId), { body: data });
            this.logger?.info(`Deployed ${data.length} commands`);
        } catch (e) {
            this.logger?.error('Deploy failed', { error: String(e) });
        }
    }
}

function createConsoleLogger(): ILogger {
    return {
        info: (msg, data) => console.log(`[INFO] ${msg}`, data ?? ''),
        error: (msg, data) => console.error(`[ERROR] ${msg}`, data ?? ''),
        debug: (msg, data) => console.debug(`[DEBUG] ${msg}`, data ?? ''),
        warn: (msg, data) => console.warn(`[WARN] ${msg}`, data ?? '')
    };
}
