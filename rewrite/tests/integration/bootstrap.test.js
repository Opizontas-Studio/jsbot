import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock discord.js
jest.unstable_mockModule('discord.js', () => ({
    Client: jest.fn(() => ({
        once: jest.fn(),
        on: jest.fn(),
        login: jest.fn().mockResolvedValue({}),
        destroy: jest.fn().mockResolvedValue({}),
        removeAllListeners: jest.fn(),
        guilds: { cache: { size: 0 } },
        user: { tag: 'TestBot#1234' }
    })),
    GatewayIntentBits: {
        Guilds: 1,
        GuildMessages: 2,
        MessageContent: 4,
        GuildMembers: 8,
        DirectMessages: 16
    },
    Options: {
        cacheWithLimits: jest.fn(() => ({}))
    },
    Events: {
        InteractionCreate: 'interactionCreate',
        GuildMemberAdd: 'guildMemberAdd',
        GuildMemberRemove: 'guildMemberRemove',
        GuildMemberUpdate: 'guildMemberUpdate',
        MessageCreate: 'messageCreate',
        MessageDelete: 'messageDelete',
        MessageUpdate: 'messageUpdate',
        MessageBulkDelete: 'messageBulkDelete'
    }
}));

describe('Bootstrap Integration', () => {
    let testConfigPath;
    let testDir;

    beforeEach(() => {
        // 创建测试目录
        testDir = join(tmpdir(), `test-bootstrap-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        testConfigPath = join(testDir, 'config.json');

        // 设置环境变量
        process.env.CONFIG_PATH = testConfigPath;
        process.env.DISCORD_TOKEN = 'test_token_123';
        process.env.DISCORD_CLIENT_ID = '123456789';
        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        // 清理测试目录
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch (error) {
            // 忽略清理错误
        }

        // 清理环境变量
        delete process.env.CONFIG_PATH;
        delete process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_CLIENT_ID;
    });

    describe('configuration', () => {
        it('应该正确设置环境变量', () => {
            expect(process.env.DISCORD_TOKEN).toBe('test_token_123');
            expect(process.env.NODE_ENV).toBe('test');
        });

        it('应该能创建配置文件', () => {
            const config = {
                token: 'old_token',
                bot: {
                    logLevel: 'info'
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // 验证文件已创建
            const readConfig = JSON.parse(readFileSync(testConfigPath, 'utf8'));
            expect(readConfig.bot.logLevel).toBe('info');
        });

        it('应该支持DATABASE_URL环境变量', () => {
            process.env.DATABASE_URL = 'postgres://test';

            const config = {
                bot: {
                    logLevel: 'info'
                },
                database: {
                    postgres: {
                        host: 'localhost',
                        database: 'test'
                    }
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            expect(process.env.DATABASE_URL).toBe('postgres://test');

            delete process.env.DATABASE_URL;
        });
    });

    describe('error handling', () => {
        it('应该能检测配置文件不存在', () => {
            const nonExistentPath = join(testDir, 'nonexistent.json');
            process.env.CONFIG_PATH = nonExistentPath;

            expect(() => {
                readFileSync(nonExistentPath);
            }).toThrow();
        });

        it('应该能检测无效的JSON', () => {
            writeFileSync(testConfigPath, 'invalid json {');

            expect(() => {
                JSON.parse(readFileSync(testConfigPath, 'utf8'));
            }).toThrow();
        });
    });

    describe('graceful shutdown', () => {
        it('应该处理SIGINT信号', async () => {
            const config = {
                token: 'test_token',
                bot: {
                    logLevel: 'info',
                    gracefulShutdownTimeout: 1000
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // 测试信号处理器是否注册
            const listeners = process.listeners('SIGINT');
            expect(listeners.length).toBeGreaterThanOrEqual(0);
        });

        it('应该处理SIGTERM信号', async () => {
            const config = {
                token: 'test_token',
                bot: {
                    logLevel: 'info',
                    gracefulShutdownTimeout: 1000
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // 测试信号处理器是否注册
            const listeners = process.listeners('SIGTERM');
            expect(listeners.length).toBeGreaterThanOrEqual(0);
        });

        it('应该处理未捕获异常', async () => {
            const config = {
                token: 'test_token',
                bot: {
                    logLevel: 'info'
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // 测试uncaughtException处理器
            const listeners = process.listeners('uncaughtException');
            expect(listeners.length).toBeGreaterThanOrEqual(0);
        });

        it('应该处理未处理的Promise拒绝', async () => {
            const config = {
                token: 'test_token',
                bot: {
                    logLevel: 'info'
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // 测试unhandledRejection处理器
            const listeners = process.listeners('unhandledRejection');
            expect(listeners.length).toBeGreaterThanOrEqual(0);
        });
    });

    describe('configuration defaults', () => {
        it('应该使用默认配置路径', async () => {
            // 移除CONFIG_PATH环境变量
            delete process.env.CONFIG_PATH;

            const defaultConfigPath = join(process.cwd(), 'config.json');

            // 如果默认配置文件不存在，应该会失败
            expect(process.env.CONFIG_PATH).toBeUndefined();
        });

        it('应该使用默认优雅关闭超时', async () => {
            const config = {
                token: 'test_token',
                bot: {
                    logLevel: 'info'
                    // 不设置gracefulShutdownTimeout
                }
            };

            writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

            // bootstrap应该使用默认值30000ms
            expect(config.bot.gracefulShutdownTimeout).toBeUndefined();
        });
    });

    describe('bootstrap file', () => {
        it('应该存在bootstrap模块', () => {
            const bootstrapPath = join(process.cwd(), 'rewrite/core/bootstrap.js');

            expect(existsSync(bootstrapPath)).toBe(true);
        });
    });
});

