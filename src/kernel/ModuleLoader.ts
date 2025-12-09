/**
 * 模块加载器 - 模块的扫描、加载、卸载和热重载
 * @module kernel/ModuleLoader
 */

import { readdir, stat } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { inject, injectable } from 'tsyringe';
import { pathToFileURL } from 'url';
import type { AnyConfig } from '../types/config.js';
import { Registry } from './Registry.js';

export interface ModuleInfo {
    name: string;
    path: string;
    loadedAt: Date;
    configIds: string[];
}

export interface LoadResult {
    success: boolean;
    moduleName: string;
    configCount: number;
    errors: string[];
}

export const LOGGER_TOKEN = Symbol('Logger');

export interface Logger {
    info(msg: string, data?: object): void;
    error(msg: string, data?: object): void;
    debug(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
}

const SCAN_SUBDIRS = ['commands', 'components', 'events', 'tasks'];
const VALID_TYPES = ['command', 'commandGroup', 'button', 'selectMenu', 'modal', 'event', 'task'];

@injectable()
export class ModuleLoader {
    private loadedModules = new Map<string, ModuleInfo>();
    private cacheVersion = new Map<string, number>();

    constructor(@inject(Registry) private registry: Registry, @inject(LOGGER_TOKEN) private logger: Logger) {}

    async loadAll(modulesPath: string): Promise<LoadResult[]> {
        const results: LoadResult[] = [];
        const absPath = resolve(modulesPath);

        try {
            const entries = await readdir(absPath, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && !e.name.startsWith('.')) {
                    results.push(await this.load(e.name, absPath));
                }
            }
            this.logger.info('Modules loaded', {
                total: results.length,
                success: results.filter(r => r.success).length
            });
        } catch (err) {
            this.logger.error('Failed to scan modules', { path: absPath, error: String(err) });
        }

        return results;
    }

    async load(moduleName: string, basePath?: string): Promise<LoadResult> {
        const result: LoadResult = { success: false, moduleName, configCount: 0, errors: [] };
        const modulePath = basePath ? join(basePath, moduleName) : join(process.cwd(), 'src/modules', moduleName);

        if (this.loadedModules.has(moduleName)) {
            result.errors.push(`Module "${moduleName}" already loaded`);
            return result;
        }

        try {
            const s = await stat(modulePath).catch(() => null);
            if (!s?.isDirectory()) {
                result.errors.push(`Module directory not found: ${modulePath}`);
                return result;
            }

            const configs = await this.scanAndLoad(modulePath, moduleName);
            for (const config of configs) {
                config._module = moduleName;
                this.registry.register(config);
            }

            this.loadedModules.set(moduleName, {
                name: moduleName,
                path: modulePath,
                loadedAt: new Date(),
                configIds: configs.map(c => c.id)
            });

            result.success = true;
            result.configCount = configs.length;
            this.logger.info(`Module loaded: ${moduleName}`, { configs: configs.length });
        } catch (err) {
            result.errors.push(String(err));
            this.logger.error(`Failed to load: ${moduleName}`, { error: String(err) });
        }

        return result;
    }

    async unload(moduleName: string): Promise<boolean> {
        if (!this.loadedModules.has(moduleName)) {
            this.logger.warn(`Module "${moduleName}" not loaded`);
            return false;
        }

        this.registry.unregisterByModule(moduleName);
        this.loadedModules.delete(moduleName);
        this.cacheVersion.set(moduleName, (this.cacheVersion.get(moduleName) ?? 0) + 1);
        this.logger.info(`Module unloaded: ${moduleName}`);
        return true;
    }

    async reload(moduleName: string): Promise<LoadResult> {
        const info = this.loadedModules.get(moduleName);
        const basePath = info ? dirname(info.path) : undefined;
        await this.unload(moduleName);
        return this.load(moduleName, basePath);
    }

    getLoadedModules(): string[] {
        return Array.from(this.loadedModules.keys());
    }

    getModuleInfo(moduleName: string): ModuleInfo | undefined {
        return this.loadedModules.get(moduleName);
    }

    isLoaded(moduleName: string): boolean {
        return this.loadedModules.has(moduleName);
    }

    private async scanAndLoad(modulePath: string, moduleName: string): Promise<AnyConfig[]> {
        const configs: AnyConfig[] = [];

        for (const subdir of SCAN_SUBDIRS) {
            const subdirPath = join(modulePath, subdir);
            const s = await stat(subdirPath).catch(() => null);
            if (!s?.isDirectory()) continue;

            for (const file of await this.scanFiles(subdirPath)) {
                configs.push(...(await this.loadFile(file, moduleName)));
            }
        }

        return configs;
    }

    private async scanFiles(dirPath: string): Promise<string[]> {
        const files: string[] = [];
        for (const entry of await readdir(dirPath, { withFileTypes: true })) {
            const fullPath = join(dirPath, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await this.scanFiles(fullPath)));
            } else if (this.isConfigFile(entry.name)) {
                files.push(fullPath);
            }
        }
        return files;
    }

    private isConfigFile(name: string): boolean {
        if (name.includes('.test.') || name.includes('.spec.') || name.endsWith('.d.ts')) return false;
        return name.endsWith('.ts') || name.endsWith('.js');
    }

    private async loadFile(filePath: string, moduleName: string): Promise<AnyConfig[]> {
        const configs: AnyConfig[] = [];
        try {
            const v = this.cacheVersion.get(moduleName) ?? 0;
            const url = pathToFileURL(filePath).href + `?v=${v}&t=${Date.now()}`;
            const mod = await import(url);

            if (mod.default) {
                if (this.isValidConfig(mod.default)) {
                    configs.push(mod.default);
                } else if (Array.isArray(mod.default)) {
                    configs.push(...mod.default.filter((c: unknown) => this.isValidConfig(c)));
                }
            }

            for (const [key, value] of Object.entries(mod)) {
                if (key !== 'default' && this.isValidConfig(value)) {
                    configs.push(value as AnyConfig);
                }
            }
        } catch (err) {
            this.logger.error(`Failed to load file: ${filePath}`, { error: String(err) });
        }
        return configs;
    }

    private isValidConfig(value: unknown): value is AnyConfig {
        if (!value || typeof value !== 'object') return false;
        const obj = value as Record<string, unknown>;
        return typeof obj.id === 'string' && typeof obj.type === 'string' && VALID_TYPES.includes(obj.type);
    }
}
