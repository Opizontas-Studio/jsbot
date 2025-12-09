/**
 * 配置注册中心 - 配置注册和路由查找
 * @module kernel/Registry
 */

import { injectable } from 'tsyringe';
import { Pattern, type CompiledPattern } from './Pattern.js';
import type {
    AnyConfig,
    CommandConfig,
    CommandGroupConfig,
    ButtonConfig,
    SelectMenuConfig,
    ModalConfig,
    EventConfig,
    TaskConfig,
    SubcommandConfig,
    RouteMatch,
    DiscordEvent,
} from '../types/config.js';

interface CompiledRoute<T extends ButtonConfig | SelectMenuConfig | ModalConfig> {
    config: T;
    pattern: CompiledPattern;
}

interface CommandEntry {
    config: CommandConfig | CommandGroupConfig;
    subcommands?: Map<string, SubcommandConfig>;
}

export interface RegistryStats {
    commands: number;
    commandGroups: number;
    buttons: number;
    selectMenus: number;
    modals: number;
    events: number;
    tasks: number;
    modules: string[];
}

@injectable()
export class Registry {
    private commands = new Map<string, CommandEntry>();
    private buttons = new Map<string, CompiledRoute<ButtonConfig>>();
    private selectMenus = new Map<string, CompiledRoute<SelectMenuConfig>>();
    private modals = new Map<string, CompiledRoute<ModalConfig>>();
    private events = new Map<DiscordEvent, EventConfig[]>();
    private tasks = new Map<string, TaskConfig>();
    private moduleConfigs = new Map<string, Set<string>>();

    register(config: AnyConfig): void {
        switch (config.type) {
            case 'command':
                this.commands.set((config as CommandConfig).name, { config: config as CommandConfig });
                break;
            case 'commandGroup': {
                const groupConfig = config as CommandGroupConfig;
                const subcommands = new Map<string, SubcommandConfig>();
                for (const sub of groupConfig.subcommands) {
                    subcommands.set(sub.name, sub);
                }
                this.commands.set(groupConfig.name, { config: groupConfig, subcommands });
                break;
            }
            case 'button': {
                const btnConfig = config as ButtonConfig;
                this.buttons.set(btnConfig.pattern, { config: btnConfig, pattern: Pattern.compile(btnConfig.pattern) });
                break;
            }
            case 'selectMenu': {
                const menuConfig = config as SelectMenuConfig;
                this.selectMenus.set(menuConfig.pattern, { config: menuConfig, pattern: Pattern.compile(menuConfig.pattern) });
                break;
            }
            case 'modal': {
                const modalConfig = config as ModalConfig;
                this.modals.set(modalConfig.pattern, { config: modalConfig, pattern: Pattern.compile(modalConfig.pattern) });
                break;
            }
            case 'event': {
                const eventConfig = config as EventConfig;
                const existing = this.events.get(eventConfig.event) ?? [];
                existing.push(eventConfig);
                existing.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
                this.events.set(eventConfig.event, existing);
                break;
            }
            case 'task':
                this.tasks.set(config.id, config as TaskConfig);
                break;
        }

        if (config._module) {
            let configs = this.moduleConfigs.get(config._module);
            if (!configs) {
                configs = new Set();
                this.moduleConfigs.set(config._module, configs);
            }
            configs.add(config.id);
        }
    }

    findCommand(name: string, subcommandName?: string | null): CommandConfig | CommandGroupConfig | SubcommandConfig | null {
        const entry = this.commands.get(name);
        if (!entry) return null;
        if (subcommandName && entry.subcommands) {
            return entry.subcommands.get(subcommandName) ?? null;
        }
        return entry.config;
    }

    getCommandGroupConfig(name: string): CommandGroupConfig | null {
        const entry = this.commands.get(name);
        if (entry?.config.type === 'commandGroup') {
            return entry.config as CommandGroupConfig;
        }
        return null;
    }

    findButton(customId: string): RouteMatch<ButtonConfig> | null {
        for (const route of this.buttons.values()) {
            const params = route.pattern.extract(customId);
            if (params) return { config: route.config, params };
        }
        return null;
    }

    findSelectMenu(customId: string): RouteMatch<SelectMenuConfig> | null {
        for (const route of this.selectMenus.values()) {
            const params = route.pattern.extract(customId);
            if (params) return { config: route.config, params };
        }
        return null;
    }

    findModal(customId: string): RouteMatch<ModalConfig> | null {
        for (const route of this.modals.values()) {
            const params = route.pattern.extract(customId);
            if (params) return { config: route.config, params };
        }
        return null;
    }

    getEventHandlers(event: DiscordEvent): EventConfig[] {
        return this.events.get(event) ?? [];
    }

    getAllTasks(): TaskConfig[] {
        return Array.from(this.tasks.values());
    }

    getAllCommands(): (CommandConfig | CommandGroupConfig)[] {
        return Array.from(this.commands.values()).map(entry => entry.config);
    }

    unregisterByModule(moduleName: string): void {
        if (!this.moduleConfigs.has(moduleName)) return;

        for (const [name, entry] of this.commands) {
            if (entry.config._module === moduleName) this.commands.delete(name);
        }
        for (const [pattern, route] of this.buttons) {
            if (route.config._module === moduleName) this.buttons.delete(pattern);
        }
        for (const [pattern, route] of this.selectMenus) {
            if (route.config._module === moduleName) this.selectMenus.delete(pattern);
        }
        for (const [pattern, route] of this.modals) {
            if (route.config._module === moduleName) this.modals.delete(pattern);
        }
        for (const [event, handlers] of this.events) {
            const filtered = handlers.filter(h => h._module !== moduleName);
            if (filtered.length === 0) this.events.delete(event);
            else this.events.set(event, filtered);
        }
        for (const [id, task] of this.tasks) {
            if (task._module === moduleName) this.tasks.delete(id);
        }
        this.moduleConfigs.delete(moduleName);
    }

    clear(): void {
        this.commands.clear();
        this.buttons.clear();
        this.selectMenus.clear();
        this.modals.clear();
        this.events.clear();
        this.tasks.clear();
        this.moduleConfigs.clear();
    }

    getStats(): RegistryStats {
        let commands = 0, commandGroups = 0;
        for (const entry of this.commands.values()) {
            if (entry.config.type === 'command') commands++;
            else commandGroups++;
        }
        return {
            commands,
            commandGroups,
            buttons: this.buttons.size,
            selectMenus: this.selectMenus.size,
            modals: this.modals.size,
            events: Array.from(this.events.values()).reduce((sum, arr) => sum + arr.length, 0),
            tasks: this.tasks.size,
            modules: Array.from(this.moduleConfigs.keys()),
        };
    }

    hasModule(moduleName: string): boolean {
        return this.moduleConfigs.has(moduleName);
    }

    getModules(): string[] {
        return Array.from(this.moduleConfigs.keys());
    }
}
