import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager, loadConfig, loadGuildConfig } from '../../../config/loader.js';

describe('Config Loader', () => {
    let testDir;
    let configPath;
    let guildsDir;
    let envBackup;

    beforeEach(() => {
        // 备份环境变量
        envBackup = { ...process.env };

        // 创建测试目录
        testDir = join(tmpdir(), `config-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
        configPath = join(testDir, 'config.json');
        guildsDir = join(testDir, 'guilds');
        mkdirSync(guildsDir, { recursive: true });

        // 设置测试环境变量
        process.env.DISCORD_TOKEN = 'test_token_123';
        process.env.DISCORD_CLIENT_ID = '123456789012345678';
        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        // 恢复环境变量
        process.env = envBackup;

        // 清理测试目录
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('loadConfig', () => {
        it('应该成功加载有效的配置', () => {
            const testConfig = {
                bot: {
                    logLevel: 'info',
                    gracefulShutdownTimeout: 30000
                },
                database: {
                    sqlite: { path: './test.db' }
                },
                api: {
                    rateLimit: {
                        global: { maxRequests: 50, window: 1000 }
                    }
                },
                queue: {
                    concurrency: 3,
                    timeout: 900000
                }
            };

            writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

            const config = loadConfig({
                configPath,
                guildsDir
            });

            expect(config.token).toBe('test_token_123');
            expect(config.bot.clientId).toBe('123456789012345678');
            expect(config.database.sqlite.path).toBe('./test.db');
        });

        it('应该在缺少必需环境变量时抛出错误', () => {
            // 清除环境变量
            const originalToken = process.env.DISCORD_TOKEN;
            process.env.DISCORD_TOKEN = '';

            const testConfig = {
                bot: { logLevel: 'info' }
            };

            writeFileSync(configPath, JSON.stringify(testConfig));

            expect(() => loadConfig({ configPath, guildsDir }))
                .toThrow('环境变量验证失败');

            // 恢复
            process.env.DISCORD_TOKEN = originalToken;
        });

        it('应该在配置文件不存在时抛出错误', () => {
            expect(() => loadConfig({
                configPath: join(testDir, 'nonexistent.json'),
                guildsDir
            })).toThrow('配置文件不存在');
        });

        it('应该在配置格式错误时抛出错误', () => {
            writeFileSync(configPath, 'invalid json {');

            expect(() => loadConfig({ configPath, guildsDir }))
                .toThrow('配置文件解析失败');
        });

        it('应该在配置验证失败时抛出错误', () => {
            const invalidConfig = {
                bot: {
                    logLevel: 'invalid_level'
                }
            };

            writeFileSync(configPath, JSON.stringify(invalidConfig));

            expect(() => loadConfig({ configPath, guildsDir }))
                .toThrow('配置验证失败');
        });

        it('应该优先使用DATABASE_URL环境变量', () => {
            process.env.DATABASE_URL = 'postgresql://test:test@localhost/testdb';

            const testConfig = {
                bot: { logLevel: 'info' },
                database: {
                    postgres: {
                        host: 'other_host',
                        database: 'other_db',
                        user: 'user',
                        password: 'pass'
                    }
                }
            };

            writeFileSync(configPath, JSON.stringify(testConfig));

            const config = loadConfig({ configPath, guildsDir });

            expect(config.database.connectionUrl).toBe('postgresql://test:test@localhost/testdb');
        });
    });

    describe('loadGuildConfig', () => {
        it('应该成功加载服务器配置', () => {
            const guildId = '123456789012345678';
            const guildConfig = {
                guildId,
                roleIds: {
                    moderators: ['role1', 'role2']
                },
                channelIds: {
                    log: 'channel1'
                }
            };

            const guildConfigPath = join(guildsDir, `${guildId}.json`);
            writeFileSync(guildConfigPath, JSON.stringify(guildConfig, null, 2));

            const loaded = loadGuildConfig(guildId, guildsDir);

            expect(loaded).toBeDefined();
            expect(loaded.guildId).toBe(guildId);
            expect(loaded.roleIds.moderators).toEqual(['role1', 'role2']);
        });

        it('应该在配置文件不存在时返回null', () => {
            const loaded = loadGuildConfig('nonexistent', guildsDir);
            expect(loaded).toBeNull();
        });

        it('应该在JSON格式错误时返回null', () => {
            const guildId = '123456789012345678';
            const guildConfigPath = join(guildsDir, `${guildId}.json`);
            writeFileSync(guildConfigPath, 'invalid json {');

            const loaded = loadGuildConfig(guildId, guildsDir);
            expect(loaded).toBeNull();
        });
    });

    describe('ConfigManager', () => {
        let configManager;

        beforeEach(() => {
            const testConfig = {
                bot: { logLevel: 'info' },
                guildsDir
            };

            writeFileSync(configPath, JSON.stringify(testConfig));

            const config = loadConfig({ configPath, guildsDir });
            configManager = new ConfigManager(config);
        });

        it('应该返回全局配置', () => {
            const global = configManager.getGlobal();
            expect(global.bot.clientId).toBe('123456789012345678');
        });

        it('应该缓存服务器配置', () => {
            const guildId = '123456789012345678';
            const guildConfig = {
                guildId,
                roleIds: { moderators: ['role1'] }
            };

            writeFileSync(
                join(guildsDir, `${guildId}.json`),
                JSON.stringify(guildConfig)
            );

            // 首次加载
            const config1 = configManager.getGuild(guildId);
            expect(config1).toBeDefined();

            // 第二次应该使用缓存
            const config2 = configManager.getGuild(guildId);
            expect(config2).toBe(config1);
        });

        it('应该在不存在时返回null', () => {
            const config = configManager.getGuild('nonexistent');
            expect(config).toBeNull();
        });

        it('应该支持重新加载配置', () => {
            const guildId = '123456789012345678';
            const guildConfig = {
                guildId,
                roleIds: { moderators: ['role1'] }
            };

            const guildConfigPath = join(guildsDir, `${guildId}.json`);
            writeFileSync(guildConfigPath, JSON.stringify(guildConfig));

            // 首次加载
            const config1 = configManager.getGuild(guildId);
            expect(config1.roleIds.moderators).toEqual(['role1']);

            // 修改配置文件
            guildConfig.roleIds.moderators = ['role2', 'role3'];
            writeFileSync(guildConfigPath, JSON.stringify(guildConfig));

            // 重新加载
            const config2 = configManager.reloadGuild(guildId);
            expect(config2.roleIds.moderators).toEqual(['role2', 'role3']);
        });

        it('应该支持预加载所有服务器配置', () => {
            // 创建多个服务器配置
            const guildIds = ['111', '222', '333'];
            for (const guildId of guildIds) {
                writeFileSync(
                    join(guildsDir, `${guildId}.json`),
                    JSON.stringify({ guildId })
                );
            }

            const count = configManager.preloadAllGuilds();
            expect(count).toBe(3);

            // 验证都已缓存
            for (const guildId of guildIds) {
                const config = configManager.getGuild(guildId);
                expect(config).toBeDefined();
            }
        });

        it('应该支持清除缓存', () => {
            const guildId = '123456789012345678';
            writeFileSync(
                join(guildsDir, `${guildId}.json`),
                JSON.stringify({ guildId })
            );

            // 加载并缓存
            configManager.getGuild(guildId);
            expect(configManager.guildConfigs.size).toBe(1);

            // 清除缓存
            configManager.clearCache();
            expect(configManager.guildConfigs.size).toBe(0);
        });
    });
});

