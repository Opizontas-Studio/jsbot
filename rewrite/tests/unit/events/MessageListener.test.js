import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import { MessageListener } from '../../../core/events/MessageListener.js';

describe('MessageListener', () => {
    let listener;
    let mockContainer;
    let mockRegistry;
    let mockLogger;
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
            getEventHandlers: vi.fn(() => [])
        };

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };

        mockClient = {
            on: vi.fn()
        };

        listener = new MessageListener(mockContainer, mockRegistry, mockLogger);
    });

    describe('register', () => {
        it('应该注册所有消息事件', () => {
            listener.register(mockClient);

            expect(mockClient.on).toHaveBeenCalledWith(
                Events.MessageCreate,
                expect.any(Function)
            );
            expect(mockClient.on).toHaveBeenCalledWith(
                Events.MessageDelete,
                expect.any(Function)
            );
            expect(mockClient.on).toHaveBeenCalledWith(
                Events.MessageUpdate,
                expect.any(Function)
            );
            expect(mockClient.on).toHaveBeenCalledWith(
                Events.MessageBulkDelete,
                expect.any(Function)
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                '[MessageListener] 已注册'
            );
        });
    });

    describe('dispatchEvent', () => {
        it('应该跳过无处理器的事件', async () => {
            mockRegistry.getEventHandlers.mockReturnValue([]);

            await listener.dispatchEvent('messageCreate', {});

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('应该执行所有处理器', async () => {
            const handler1 = {
                id: 'handler1',
                handle: vi.fn().mockResolvedValue({})
            };

            const handler2 = {
                id: 'handler2',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler1, handler2]);

            const eventData = {
                guild: { id: 'guild123' },
                content: 'test message'
            };

            await listener.dispatchEvent('messageCreate', eventData);

            expect(handler1.handle).toHaveBeenCalledWith(eventData, {});
            expect(handler2.handle).toHaveBeenCalledWith(eventData, {});
        });

        it('应该按优先级顺序执行', async () => {
            const executionOrder = [];

            const handler1 = {
                id: 'handler1',
                priority: 10,
                handle: vi.fn(async () => executionOrder.push('handler1'))
            };

            const handler2 = {
                id: 'handler2',
                priority: 5,
                handle: vi.fn(async () => executionOrder.push('handler2'))
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler1, handler2]);

            await listener.dispatchEvent('messageCreate', {
                guild: { id: 'guild123' }
            });

            expect(executionOrder).toEqual(['handler1', 'handler2']);
        });

        it('应该执行filter检查', async () => {
            const handler = {
                id: 'handler1',
                filter: vi.fn(() => false),
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler]);

            await listener.dispatchEvent('messageCreate', {
                guild: { id: 'guild123' }
            });

            expect(handler.filter).toHaveBeenCalled();
            expect(handler.handle).not.toHaveBeenCalled();
        });

        it('应该解析依赖', async () => {
            const handler = {
                id: 'handler1',
                inject: ['messageService'],
                handle: vi.fn().mockResolvedValue({})
            };

            const mockDeps = { messageService: {} };
            mockContainer.resolve.mockReturnValue(mockDeps);
            mockRegistry.getEventHandlers.mockReturnValue([handler]);

            await listener.dispatchEvent('messageCreate', {
                guild: { id: 'guild123' }
            });

            expect(mockContainer.resolve).toHaveBeenCalledWith(['messageService']);
            expect(handler.handle).toHaveBeenCalledWith(
                expect.any(Object),
                mockDeps
            );
        });

        it('应该捕获处理器错误并继续', async () => {
            const handler1 = {
                id: 'handler1',
                handle: vi.fn().mockRejectedValue(new Error('Handler error'))
            };

            const handler2 = {
                id: 'handler2',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler1, handler2]);

            await listener.dispatchEvent('messageCreate', {
                guild: { id: 'guild123' }
            });

            expect(mockLogger.error).toHaveBeenCalledWith({
                msg: '事件处理器错误: messageCreate',
                handlerId: 'handler1',
                error: 'Handler error',
                stack: expect.any(String)
            });
            expect(handler2.handle).toHaveBeenCalled();
        });

        it('应该处理messageUpdate事件', async () => {
            const handler = {
                id: 'handler1',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler]);

            const oldMessage = { guild: { id: 'guild123' } };
            const newMessage = { guild: { id: 'guild123' } };

            await listener.dispatchEvent('messageUpdate', {
                oldMessage,
                newMessage
            });

            expect(handler.handle).toHaveBeenCalledWith(
                { oldMessage, newMessage },
                {}
            );
        });

        it('应该记录debug日志', async () => {
            const handler = {
                id: 'handler1',
                handle: vi.fn().mockResolvedValue({})
            };

            mockRegistry.getEventHandlers.mockReturnValue([handler]);

            await listener.dispatchEvent('messageCreate', {
                guild: { id: 'guild123' }
            });

            expect(mockLogger.debug).toHaveBeenCalledWith({
                msg: '处理事件: messageCreate',
                handlersCount: 1
            });

            expect(mockLogger.debug).toHaveBeenCalledWith({
                msg: '事件处理完成: messageCreate',
                handlerId: 'handler1'
            });
        });
    });

    describe('getGuildConfig', () => {
        it('应该获取服务器配置', () => {
            const config = listener.getGuildConfig('guild123');
            expect(mockContainer.get).toHaveBeenCalledWith('configManager');
            expect(config).toEqual({ guildId: 'guild123' });
        });

        it('应该返回空对象当无guildId', () => {
            const config = listener.getGuildConfig(null);
            expect(config).toEqual({});
        });
    });
});

