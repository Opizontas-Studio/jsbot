import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionListener } from '../../../core/events/InteractionListener.js';

describe('InteractionListener', () => {
    let listener;
    let mockContainer;
    let mockRegistry;
    let mockLogger;
    let mockMiddlewareChain;
    let mockClient;

    beforeEach(() => {
        mockContainer = {
            get: vi.fn((name) => {
                if (name === 'configManager') {
                    return {
                        getGuildConfig: vi.fn(() => ({ guildId: 'guild123' }))
                    };
                }
                return {};
            }),
            resolve: vi.fn(() => ({}))
        };

        mockRegistry = {
            findCommand: vi.fn(),
            findButton: vi.fn(),
            findSelectMenu: vi.fn(),
            findModal: vi.fn()
        };

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        };

        mockMiddlewareChain = {
            execute: vi.fn(async (ctx, config, handler) => await handler())
        };

        mockClient = {
            on: vi.fn()
        };

        listener = new InteractionListener(
            mockContainer,
            mockRegistry,
            mockLogger,
            mockMiddlewareChain
        );
    });

    describe('register', () => {
        it('应该注册InteractionCreate事件', () => {
            listener.register(mockClient);

            expect(mockClient.on).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Function)
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                '[InteractionListener] 已注册'
            );
        });
    });

    describe('handle', () => {
        it('应该处理斜杠命令', async () => {
            const mockInteraction = {
                isChatInputCommand: () => true,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => false,
                commandName: 'testcmd',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.cmd',
                execute: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findCommand.mockReturnValue(mockConfig);

            await listener.handle(mockInteraction);

            expect(mockRegistry.findCommand).toHaveBeenCalledWith('testcmd');
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });

        it('应该处理上下文菜单命令', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => true,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => false,
                commandName: 'contextcmd',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.context',
                execute: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findCommand.mockReturnValue(mockConfig);

            await listener.handle(mockInteraction);

            expect(mockRegistry.findCommand).toHaveBeenCalledWith('contextcmd');
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });

        it('应该处理按钮交互', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => false,
                isButton: () => true,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => false,
                customId: 'btn_123',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.btn',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findButton.mockReturnValue({
                config: mockConfig,
                params: { id: '123' }
            });

            await listener.handle(mockInteraction);

            expect(mockRegistry.findButton).toHaveBeenCalledWith('btn_123');
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });

        it('应该处理选择菜单交互', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => true,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => false,
                customId: 'select_123',
                values: ['option1', 'option2'],
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.select',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findSelectMenu.mockReturnValue({
                config: mockConfig,
                params: { id: '123' }
            });

            await listener.handle(mockInteraction);

            expect(mockRegistry.findSelectMenu).toHaveBeenCalledWith('select_123');
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });

        it('应该处理模态框提交', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => true,
                isAutocomplete: () => false,
                customId: 'modal_123',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.modal',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findModal.mockReturnValue({
                config: mockConfig,
                params: { id: '123' }
            });

            await listener.handle(mockInteraction);

            expect(mockRegistry.findModal).toHaveBeenCalledWith('modal_123');
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });

        it('应该处理自动补全', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => true,
                commandName: 'testcmd',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            const mockConfig = {
                id: 'test.cmd',
                autocomplete: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findCommand.mockReturnValue(mockConfig);

            await listener.handle(mockInteraction);

            expect(mockConfig.autocomplete).toHaveBeenCalled();
        });

        it('应该记录未找到命令的警告', async () => {
            const mockInteraction = {
                isChatInputCommand: () => true,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => false,
                commandName: 'unknown',
                guildId: 'guild123',
                user: { id: 'user123' }
            };

            mockRegistry.findCommand.mockReturnValue(null);

            await listener.handle(mockInteraction);

            expect(mockLogger.warn).toHaveBeenCalledWith({
                msg: '未找到命令',
                commandName: 'unknown',
                userId: 'user123'
            });
        });

        it('应该处理autocomplete错误', async () => {
            const mockInteraction = {
                isChatInputCommand: () => false,
                isContextMenuCommand: () => false,
                isButton: () => false,
                isStringSelectMenu: () => false,
                isUserSelectMenu: () => false,
                isRoleSelectMenu: () => false,
                isChannelSelectMenu: () => false,
                isModalSubmit: () => false,
                isAutocomplete: () => true,
                commandName: 'testcmd',
                guildId: 'guild123',
                user: { id: 'user123' },
                respond: vi.fn().mockResolvedValue({})
            };

            const mockConfig = {
                id: 'test.cmd',
                autocomplete: vi.fn().mockRejectedValue(new Error('Autocomplete failed'))
            };

            mockRegistry.findCommand.mockReturnValue(mockConfig);

            await listener.handle(mockInteraction);

            expect(mockLogger.warn).toHaveBeenCalledWith({
                msg: '自动补全失败',
                commandName: 'testcmd',
                error: 'Autocomplete failed'
            });
            expect(mockInteraction.respond).toHaveBeenCalledWith([]);
        });
    });

    describe('handleCommand', () => {
        it('应该解析依赖并执行命令', async () => {
            const mockInteraction = {
                commandName: 'testcmd',
                guildId: 'guild123',
                user: { id: 'user123' },
                client: {},
                guild: {},
                member: {},
                channel: {}
            };

            const mockDeps = { testService: {} };
            const mockConfig = {
                id: 'test.cmd',
                inject: ['testService'],
                execute: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findCommand.mockReturnValue(mockConfig);
            mockContainer.resolve.mockReturnValue(mockDeps);

            await listener.handleCommand(mockInteraction);

            expect(mockContainer.resolve).toHaveBeenCalledWith(['testService']);
            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
        });
    });

    describe('handleButton', () => {
        it('应该传递params到handler', async () => {
            const mockInteraction = {
                customId: 'btn_123',
                guildId: 'guild123',
                user: { id: 'user123' },
                client: {},
                guild: {},
                member: {},
                channel: {}
            };

            const mockConfig = {
                id: 'test.btn',
                handle: vi.fn().mockResolvedValue({})
            };

            const params = { id: '123' };

            mockRegistry.findButton.mockReturnValue({
                config: mockConfig,
                params
            });

            await listener.handleButton(mockInteraction);

            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
            // 验证params被传递到了handler
            const executeFn = mockMiddlewareChain.execute.mock.calls[0][2];
            await executeFn();
            expect(mockConfig.handle).toHaveBeenCalledWith(
                expect.any(Object),
                params,
                expect.any(Object)
            );
        });
    });

    describe('handleSelectMenu', () => {
        it('应该设置selectedValues到context', async () => {
            const mockInteraction = {
                customId: 'select_123',
                values: ['option1', 'option2'],
                guildId: 'guild123',
                user: { id: 'user123' },
                client: {},
                guild: {},
                member: {},
                channel: {}
            };

            const mockConfig = {
                id: 'test.select',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.findSelectMenu.mockReturnValue({
                config: mockConfig,
                params: { id: '123' }
            });

            await listener.handleSelectMenu(mockInteraction);

            expect(mockMiddlewareChain.execute).toHaveBeenCalled();
            const ctx = mockMiddlewareChain.execute.mock.calls[0][0];
            expect(ctx.selectedValues).toEqual(['option1', 'option2']);
        });
    });
});

