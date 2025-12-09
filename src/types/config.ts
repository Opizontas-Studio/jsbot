/**
 * 配置类型定义
 * @module types/config
 */

import type {
    ClientEvents,
    ContextMenuCommandBuilder,
    SlashCommandBuilder,
    SlashCommandSubcommandsOnlyBuilder
} from 'discord.js';
import type {
    AutocompleteContext,
    ButtonContext,
    CommandContext,
    ModalContext,
    SelectMenuContext
} from '../kernel/Context.js';

// 基础类型
export type ConfigType = 'command' | 'commandGroup' | 'button' | 'selectMenu' | 'modal' | 'event' | 'task';
export type CommandKind = 'slash' | 'userContext' | 'messageContext';
export type DeferOption = boolean | { ephemeral: boolean };

// Usage 约束
export type UsageConstraint = string | string[] | UsageConstraintObject;
export interface UsageConstraintObject {
    all?: string[];
    any?: string[];
    not?: string[];
}

// 基础配置
export interface BaseConfig {
    id: string; // 配置唯一标识符，格式：moduleName.configName
    type: ConfigType;
    defer?: DeferOption;
    usage?: UsageConstraint;
    permissions?: string[];
    cooldown?: number;
    _module?: string; // 所属模块名称（由 ModuleLoader 自动填充）
}

// 命令配置
export interface CommandConfig extends BaseConfig {
    type: 'command';
    commandKind: CommandKind;
    name: string;
    description?: string;
    builder?: (this: CommandConfig) => SlashCommandBuilder | ContextMenuCommandBuilder;
    execute: (ctx: CommandContext) => Promise<void>;
    autocomplete?: (ctx: AutocompleteContext) => Promise<void>;
}

// 子命令配置
export interface SubcommandConfig {
    id: string;
    name: string;
    cooldown?: number;
    execute: (ctx: CommandContext) => Promise<void>;
    autocomplete?: (ctx: AutocompleteContext) => Promise<void>;
}

// 命令组配置(只支持 slash )
export interface CommandGroupConfig extends BaseConfig {
    type: 'commandGroup';
    commandKind: 'slash';
    name: string;
    description: string;
    shared?: Partial<Omit<BaseConfig, 'id' | 'type'>>;
    builder: (this: CommandGroupConfig) => SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
    subcommands: SubcommandConfig[];
}

// 按钮配置
export interface ButtonConfig extends BaseConfig {
    type: 'button';
    pattern: string;
    handle: (ctx: ButtonContext, params: Record<string, unknown>) => Promise<void>;
}

// 选择菜单配置
export interface SelectMenuConfig extends BaseConfig {
    type: 'selectMenu';
    pattern: string;
    handle: (ctx: SelectMenuContext, params: Record<string, unknown>) => Promise<void>;
}

// 模态框配置
export interface ModalConfig extends BaseConfig {
    type: 'modal';
    pattern: string;
    handle: (ctx: ModalContext, params: Record<string, unknown>) => Promise<void>;
}

// 事件配置
export type DiscordEvent = keyof ClientEvents;
export interface EventConfig<E extends DiscordEvent = DiscordEvent>
    extends Omit<BaseConfig, 'defer' | 'usage' | 'permissions' | 'cooldown'> {
    type: 'event';
    event: E; // Discord 事件名
    once?: boolean;
    priority?: number; // 优先级（数字越大越先执行）
    filter?: (...args: ClientEvents[E]) => boolean;
    handle: (...args: ClientEvents[E]) => Promise<void>;
}

// 定时任务配置

export interface TaskConfig {
    id: string;
    type: 'task';
    schedule: string; // cron 表达式
    _module?: string; // 所属模块名称（由 ModuleLoader 自动填充）
    execute: () => Promise<void>;
}

// 联合类型
export type AnyConfig =
    | CommandConfig
    | CommandGroupConfig
    | ButtonConfig
    | SelectMenuConfig
    | ModalConfig
    | EventConfig
    | TaskConfig;

export type InteractionConfig = CommandConfig | CommandGroupConfig | ButtonConfig | SelectMenuConfig | ModalConfig;
export type ComponentConfig = ButtonConfig | SelectMenuConfig | ModalConfig;

// 路由匹配结果
export interface RouteMatch<T extends ComponentConfig = ComponentConfig> {
    config: T;
    params: Record<string, unknown>;
}

// 应用配置

export interface BotConfig {
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    gracefulShutdownTimeout: number;
}

export interface DatabaseConfig {
    type: 'sqlite' | 'postgres';
    sqlite?: {
        path: string;
    };
    postgres?: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
    };
}

export interface QueueConfig {
    concurrency: number;
    timeout: number;
    priorities: {
        high: number;
        normal: number;
        low: number;
    };
}

export interface LockConfig {
    timeout: number;
    maxPending: number;
}

export interface AppConfig {
    bot: BotConfig;
    database: DatabaseConfig;
    queue: QueueConfig;
    lock: LockConfig;
}

// 服务器配置

export interface GuildConfig {
    guildId: string;
    prefix?: string;
    locale?: string;
    features?: Record<string, boolean>;
    [key: string]: unknown;
}

// 类型守卫

export function isCommandConfig(config: AnyConfig): config is CommandConfig {
    return config.type === 'command';
}

export function isCommandGroupConfig(config: AnyConfig): config is CommandGroupConfig {
    return config.type === 'commandGroup';
}

export function isButtonConfig(config: AnyConfig): config is ButtonConfig {
    return config.type === 'button';
}

export function isSelectMenuConfig(config: AnyConfig): config is SelectMenuConfig {
    return config.type === 'selectMenu';
}

export function isModalConfig(config: AnyConfig): config is ModalConfig {
    return config.type === 'modal';
}

export function isEventConfig(config: AnyConfig): config is EventConfig {
    return config.type === 'event';
}

export function isTaskConfig(config: AnyConfig): config is TaskConfig {
    return config.type === 'task';
}

export function isInteractionConfig(config: AnyConfig): config is InteractionConfig {
    return ['command', 'commandGroup', 'button', 'selectMenu', 'modal'].includes(config.type);
}

export function isComponentConfig(config: AnyConfig): config is ComponentConfig {
    return ['button', 'selectMenu', 'modal'].includes(config.type);
}
