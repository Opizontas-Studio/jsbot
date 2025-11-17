import { describe, expect, it } from 'vitest';
import {
    validateEnv,
    validateGlobalConfig,
    validateGuildConfig
} from '../../../config/schema.js';

describe('Config Schema Validation', () => {
    describe('validateEnv', () => {
        it('应该验证通过有效的环境变量', () => {
            const env = {
                DISCORD_TOKEN: 'valid_token_123',
                DISCORD_CLIENT_ID: '123456789012345678',
                NODE_ENV: 'production'
            };

            const errors = validateEnv(env);
            expect(errors).toHaveLength(0);
        });

        it('应该在缺少DISCORD_TOKEN时报错', () => {
            const env = { DISCORD_CLIENT_ID: '123456789' };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('DISCORD_TOKEN'))).toBe(true);
        });

        it('应该在DISCORD_TOKEN为空时报错', () => {
            const env = {
                DISCORD_TOKEN: '',
                DISCORD_CLIENT_ID: '123456789'
            };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('DISCORD_TOKEN'))).toBe(true);
        });

        it('应该在缺少DISCORD_CLIENT_ID时报错', () => {
            const env = { DISCORD_TOKEN: 'valid_token' };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('DISCORD_CLIENT_ID'))).toBe(true);
        });

        it('应该在DISCORD_CLIENT_ID为空时报错', () => {
            const env = {
                DISCORD_TOKEN: 'valid_token',
                DISCORD_CLIENT_ID: ''
            };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('DISCORD_CLIENT_ID'))).toBe(true);
        });

        it('应该验证DATABASE_URL格式', () => {
            const env = {
                DISCORD_TOKEN: 'token',
                DISCORD_CLIENT_ID: '123456789',
                DATABASE_URL: 'invalid_url'
            };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('DATABASE_URL'))).toBe(true);
        });

        it('应该验证NODE_ENV枚举值', () => {
            const env = {
                DISCORD_TOKEN: 'token',
                DISCORD_CLIENT_ID: '123456789',
                NODE_ENV: 'invalid_env'
            };
            const errors = validateEnv(env);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('NODE_ENV'))).toBe(true);
        });
    });

    describe('validateGlobalConfig', () => {
        it('应该验证通过有效的配置', () => {
            const config = {
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

            const errors = validateGlobalConfig(config);
            expect(errors).toHaveLength(0);
        });

        it('应该在缺少bot配置时报错', () => {
            const config = {};
            const errors = validateGlobalConfig(config);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('bot'))).toBe(true);
        });

        it('应该验证logLevel枚举值', () => {
            const config = {
                bot: {
                    logLevel: 'invalid_level'
                }
            };
            const errors = validateGlobalConfig(config);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('logLevel'))).toBe(true);
        });

        it('应该验证postgres配置完整性', () => {
            const config = {
                bot: { logLevel: 'info' },
                database: {
                    postgres: {
                        // 缺少必需字段
                        port: 5432
                    }
                }
            };
            const errors = validateGlobalConfig(config);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('host'))).toBe(true);
        });

        it('应该验证rateLimit配置', () => {
            const config = {
                bot: { logLevel: 'info' },
                api: {
                    rateLimit: {
                        global: {
                            maxRequests: -1,  // 无效值
                            window: 1000
                        }
                    }
                }
            };
            const errors = validateGlobalConfig(config);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('maxRequests'))).toBe(true);
        });

        it('应该验证queue配置', () => {
            const config = {
                bot: { logLevel: 'info' },
                queue: {
                    concurrency: 0,  // 无效值
                    timeout: -1000   // 无效值
                }
            };
            const errors = validateGlobalConfig(config);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('concurrency'))).toBe(true);
            expect(errors.some(e => e.includes('timeout'))).toBe(true);
        });
    });

    describe('validateGuildConfig', () => {
        it('应该验证通过有效的服务器配置', () => {
            const config = {
                guildId: '123456789012345678',
                roleIds: {
                    moderators: ['987654321098765432'],
                    administrators: ['876543210987654321']
                },
                channelIds: {
                    log: '765432109876543210'
                }
            };

            const errors = validateGuildConfig(config, '123456789012345678');
            expect(errors).toHaveLength(0);
        });

        it('应该在配置为空时报错', () => {
            const errors = validateGuildConfig(null, '123456789012345678');

            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0]).toContain('为空');
        });

        it('应该在guildId不匹配时警告', () => {
            const config = {
                guildId: '111111111111111111'
            };

            const errors = validateGuildConfig(config, '222222222222222222');

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('不匹配'))).toBe(true);
        });

        it('应该验证roleIds格式', () => {
            const config = {
                guildId: '123456789012345678',
                roleIds: {
                    moderators: [123, 456]  // 应该是字符串
                }
            };

            const errors = validateGuildConfig(config, '123456789012345678');

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('roleIds'))).toBe(true);
        });

        it('应该验证channelIds格式', () => {
            const config = {
                guildId: '123456789012345678',
                channelIds: {
                    log: 'invalid_id'  // 不是有效的snowflake
                }
            };

            const errors = validateGuildConfig(config, '123456789012345678');

            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(e => e.includes('channelIds'))).toBe(true);
        });

        it('应该支持数组形式的roleIds', () => {
            const config = {
                guildId: '123456789012345678',
                roleIds: {
                    moderators: [
                        '987654321098765432',
                        '876543210987654321'
                    ]
                }
            };

            const errors = validateGuildConfig(config, '123456789012345678');
            expect(errors).toHaveLength(0);
        });
    });
});

