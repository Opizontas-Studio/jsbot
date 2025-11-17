import { beforeEach, describe, expect, it } from 'vitest';
import { CommandContext, Context } from '../../core/Context.js';

describe('Context', () => {
    let mockInteraction;
    let mockConfig;
    let mockContainer;

    beforeEach(() => {
        mockInteraction = {
            user: { id: 'user123', tag: 'TestUser#1234' },
            guild: { id: 'guild123', name: 'TestGuild' },
            member: { id: 'member123', roles: { cache: new Map() } },
            channel: { id: 'channel123' },
            client: { user: { tag: 'BotUser#1234' } },
            replied: false,
            deferred: false,
            reply: vi.fn().mockResolvedValue({}),
            editReply: vi.fn().mockResolvedValue({}),
            deferReply: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
        };

        mockConfig = {
            guildId: 'guild123',
            roleIds: {
                moderators: ['mod123']
            }
        };

        mockContainer = {
            has: vi.fn((name) => name === 'logger' || name === 'registry'),
            get: vi.fn((name) => {
                if (name === 'logger') return { info: vi.fn(), error: vi.fn() };
                if (name === 'registry') return {};
                return null;
            })
        };
    });

    describe('constructor', () => {
        it('应该正确初始化基本属性', () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);

            expect(ctx.interaction).toBe(mockInteraction);
            expect(ctx.config).toBe(mockConfig);
            expect(ctx.container).toBe(mockContainer);
            expect(ctx.user).toBe(mockInteraction.user);
            expect(ctx.guild).toBe(mockInteraction.guild);
            expect(ctx.member).toBe(mockInteraction.member);
            expect(ctx.channel).toBe(mockInteraction.channel);
            expect(ctx.client).toBe(mockInteraction.client);
        });

        it('应该从容器获取logger和registry', () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);

            expect(ctx.logger).toBeDefined();
            expect(ctx.registry).toBeDefined();
        });

        it('应该处理没有容器的情况', () => {
            const ctx = new Context(mockInteraction, mockConfig, null);

            expect(ctx.container).toBeNull();
            expect(ctx.logger).toBeNull();
            expect(ctx.registry).toBeNull();
        });

        it('应该识别用户上下文菜单命令', () => {
            mockInteraction.isUserContextMenuCommand = vi.fn(() => true);
            mockInteraction.targetUser = { id: 'target123' };

            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            expect(ctx.targetUser).toBe(mockInteraction.targetUser);
        });

        it('应该识别消息上下文菜单命令', () => {
            mockInteraction.isMessageContextMenuCommand = vi.fn(() => true);
            mockInteraction.targetMessage = { id: 'message123' };

            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            expect(ctx.targetMessage).toBe(mockInteraction.targetMessage);
        });
    });

    describe('reply', () => {
        it('应该使用reply当交互未响应', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.reply('test message');

            expect(mockInteraction.reply).toHaveBeenCalledWith({ content: 'test message' });
            expect(mockInteraction.editReply).not.toHaveBeenCalled();
        });

        it('应该使用editReply当交互已defer', async () => {
            mockInteraction.deferred = true;
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.reply('test message');

            expect(mockInteraction.editReply).toHaveBeenCalledWith({ content: 'test message' });
            expect(mockInteraction.reply).not.toHaveBeenCalled();
        });

        it('应该使用editReply当交互已replied', async () => {
            mockInteraction.replied = true;
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.reply('test message');

            expect(mockInteraction.editReply).toHaveBeenCalledWith({ content: 'test message' });
            expect(mockInteraction.reply).not.toHaveBeenCalled();
        });

        it('应该使用update当useUpdate为true', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            ctx.useUpdate = true;
            await ctx.reply('test message');

            expect(mockInteraction.update).toHaveBeenCalledWith({ content: 'test message' });
            expect(mockInteraction.reply).not.toHaveBeenCalled();
        });

        it('应该接受对象作为参数', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            const replyData = { content: 'test', embeds: [] };
            await ctx.reply(replyData);

            expect(mockInteraction.reply).toHaveBeenCalledWith(replyData);
        });
    });

    describe('error', () => {
        it('应该使用纯文本错误消息当useText为true', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.error('Error message', true);

            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: '❌ Error message',
                flags: ['Ephemeral']
            });
        });

        it('应该使用ComponentV2当useText为false', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.error('Error message', false);

            expect(mockInteraction.reply).toHaveBeenCalled();
            const callArgs = mockInteraction.reply.mock.calls[0][0];
            expect(callArgs.components).toBeDefined();
            expect(callArgs.flags).toContain('Ephemeral');
        });

        it('应该默认使用ComponentV2', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.error('Error message');

            expect(mockInteraction.reply).toHaveBeenCalled();
            const callArgs = mockInteraction.reply.mock.calls[0][0];
            expect(callArgs.components).toBeDefined();
        });
    });

    describe('success', () => {
        it('应该使用纯文本成功消息当useText为true', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.success('Success message', true);

            expect(mockInteraction.reply).toHaveBeenCalledWith({
                content: '✅ Success message'
            });
        });

        it('应该使用ComponentV2当useText为false', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.success('Success message', false);

            expect(mockInteraction.reply).toHaveBeenCalled();
            const callArgs = mockInteraction.reply.mock.calls[0][0];
            expect(callArgs.components).toBeDefined();
        });
    });

    describe('defer', () => {
        it('应该调用deferReply当未响应', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.defer(true);

            expect(mockInteraction.deferReply).toHaveBeenCalledWith({
                flags: ['Ephemeral']
            });
        });

        it('应该支持非ephemeral defer', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.defer(false);

            expect(mockInteraction.deferReply).toHaveBeenCalledWith({
                flags: undefined
            });
        });

        it('应该跳过defer当已deferred', async () => {
            mockInteraction.deferred = true;
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.defer();

            expect(mockInteraction.deferReply).not.toHaveBeenCalled();
        });

        it('应该跳过defer当已replied', async () => {
            mockInteraction.replied = true;
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            await ctx.defer();

            expect(mockInteraction.deferReply).not.toHaveBeenCalled();
        });

        it('应该跳过defer当useUpdate为true', async () => {
            const ctx = new Context(mockInteraction, mockConfig, mockContainer);
            ctx.useUpdate = true;
            await ctx.defer();

            expect(mockInteraction.deferReply).not.toHaveBeenCalled();
        });
    });
});

describe('CommandContext', () => {
    let mockInteraction;
    let mockConfig;
    let mockContainer;

    beforeEach(() => {
        mockInteraction = {
            user: { id: 'user123' },
            guild: { id: 'guild123' },
            member: { id: 'member123', roles: { cache: new Map() } },
            channel: { id: 'channel123' },
            client: { user: { tag: 'BotUser#1234' } },
            replied: false,
            deferred: false,
            options: {
                get: vi.fn((name) => {
                    if (name === 'testOption') return { value: 'testValue' };
                    return null;
                }),
                getSubcommand: vi.fn(() => 'subcommand'),
                getSubcommandGroup: vi.fn(() => 'group')
            },
            reply: vi.fn().mockResolvedValue({}),
            editReply: vi.fn().mockResolvedValue({}),
            deferReply: vi.fn().mockResolvedValue({})
        };

        mockConfig = {};
        mockContainer = {
            has: vi.fn(() => false),
            get: vi.fn(() => null)
        };
    });

    describe('getOption', () => {
        it('应该获取选项值', () => {
            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const value = ctx.getOption('testOption');

            expect(value).toBe('testValue');
            expect(mockInteraction.options.get).toHaveBeenCalledWith('testOption');
        });

        it('应该返回undefined当选项不存在', () => {
            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const value = ctx.getOption('nonExistent');

            expect(value).toBeUndefined();
        });

        it('应该抛出错误当选项必需但不存在', () => {
            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);

            expect(() => {
                ctx.getOption('nonExistent', true);
            }).toThrow('Required option nonExistent not found');
        });
    });

    describe('getSubcommand', () => {
        it('应该获取子命令', () => {
            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const subcommand = ctx.getSubcommand();

            expect(subcommand).toBe('subcommand');
        });

        it('应该返回null当获取失败', () => {
            mockInteraction.options.getSubcommand = vi.fn(() => {
                throw new Error('No subcommand');
            });

            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const subcommand = ctx.getSubcommand();

            expect(subcommand).toBeNull();
        });
    });

    describe('getSubcommandGroup', () => {
        it('应该获取子命令组', () => {
            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const group = ctx.getSubcommandGroup();

            expect(group).toBe('group');
        });

        it('应该返回null当获取失败', () => {
            mockInteraction.options.getSubcommandGroup = vi.fn(() => {
                throw new Error('No group');
            });

            const ctx = new CommandContext(mockInteraction, mockConfig, mockContainer);
            const group = ctx.getSubcommandGroup();

            expect(group).toBeNull();
        });
    });
});

