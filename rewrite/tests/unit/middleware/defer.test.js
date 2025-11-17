import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferMiddleware } from '../../../core/middleware/defer.js';

describe('defer middleware', () => {
    let mockLogger;
    let mockCtx;
    let mockConfig;
    let next;

    beforeEach(() => {
        mockLogger = {
            warn: vi.fn()
        };

        mockCtx = {
            user: { id: 'user123' },
            interaction: {
                isAutocomplete: vi.fn(() => false)
            },
            defer: vi.fn().mockResolvedValue({})
        };

        mockConfig = {
            id: 'test.command',
            defer: true
        };

        next = vi.fn().mockResolvedValue({});
    });

    it('应该在无defer配置时跳过', async () => {
        const middleware = deferMiddleware(mockLogger);
        const configWithoutDefer = { ...mockConfig, defer: false };

        await middleware(mockCtx, next, configWithoutDefer);

        expect(mockCtx.defer).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('应该跳过autocomplete交互', async () => {
        mockCtx.interaction.isAutocomplete = vi.fn(() => true);
        const middleware = deferMiddleware(mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockCtx.defer).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('应该在defer配置为true时调用defer', async () => {
        const middleware = deferMiddleware(mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockCtx.defer).toHaveBeenCalledWith(true);
        expect(next).toHaveBeenCalled();
    });

    it('应该在useUpdate模式下跳过defer', async () => {
        const middleware = deferMiddleware(mockLogger);
        const configWithUpdate = { ...mockConfig, useUpdate: true };

        await middleware(mockCtx, next, configWithUpdate);

        expect(mockCtx.defer).not.toHaveBeenCalled();
        expect(mockCtx.useUpdate).toBe(true);
        expect(next).toHaveBeenCalled();
    });

    it('应该捕获defer错误并继续', async () => {
        mockCtx.defer.mockRejectedValue(new Error('Defer failed'));
        const middleware = deferMiddleware(mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockLogger.warn).toHaveBeenCalledWith({
            msg: 'Defer失败',
            error: 'Defer failed',
            userId: mockCtx.user?.id
        });
        expect(next).toHaveBeenCalled();
    });

    it('应该继续执行即使defer失败', async () => {
        mockCtx.defer.mockRejectedValue(new Error('Already deferred'));
        const middleware = deferMiddleware(mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(next).toHaveBeenCalled();
    });
});

