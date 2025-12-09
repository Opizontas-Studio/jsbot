import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cooldownMiddleware } from '../../../core/middleware/cooldown.js';

describe('cooldown middleware', () => {
    let mockCooldownManager;
    let mockLogger;
    let mockCtx;
    let mockConfig;
    let next;

    beforeEach(() => {
        mockCooldownManager = {
            check: vi.fn(() => 0),
            set: vi.fn()
        };

        mockLogger = {
            debug: vi.fn()
        };

        mockCtx = {
            user: { id: 'user123' },
            error: vi.fn().mockResolvedValue({})
        };

        mockConfig = {
            id: 'test.command',
            type: 'command',
            cooldown: 5000
        };

        next = vi.fn().mockResolvedValue({});
    });

    it('应该在无冷却配置时跳过检查', async () => {
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);
        const configWithoutCooldown = { ...mockConfig, cooldown: undefined };

        await middleware(mockCtx, next, configWithoutCooldown);

        expect(mockCooldownManager.check).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('应该在冷却期外允许执行', async () => {
        mockCooldownManager.check.mockReturnValue(0);
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockCooldownManager.check).toHaveBeenCalledWith('command:test.command:user123', 5000);
        expect(mockCooldownManager.set).toHaveBeenCalledWith('command:test.command:user123');
        expect(next).toHaveBeenCalled();
    });

    it('应该在冷却期内阻止执行', async () => {
        mockCooldownManager.check.mockReturnValue(3000);
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockCooldownManager.check).toHaveBeenCalled();
        expect(mockCooldownManager.set).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
        expect(mockCtx.error).toHaveBeenCalledWith(expect.stringContaining('3 秒'), true);
    });

    it('应该记录冷却日志', async () => {
        mockCooldownManager.check.mockReturnValue(2500);
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            msg: '冷却中',
            userId: 'user123',
            configId: 'test.command',
            remaining: 2500
        });
    });

    it('应该为每个用户独立计算冷却', async () => {
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);
        const ctx1 = { ...mockCtx, user: { id: 'user1' } };
        const ctx2 = { ...mockCtx, user: { id: 'user2' } };

        await middleware(ctx1, next, mockConfig);
        await middleware(ctx2, next, mockConfig);

        expect(mockCooldownManager.check).toHaveBeenCalledWith('command:test.command:user1', 5000);
        expect(mockCooldownManager.check).toHaveBeenCalledWith('command:test.command:user2', 5000);
    });

    it('应该正确向上取整秒数', async () => {
        mockCooldownManager.check.mockReturnValue(1500);
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockCtx.error).toHaveBeenCalledWith(expect.stringContaining('2 秒'), true);
    });

    it('应该使用正确的冷却key格式', async () => {
        const middleware = cooldownMiddleware(mockCooldownManager, mockLogger);
        const buttonConfig = {
            id: 'test.button',
            type: 'button',
            cooldown: 3000
        };

        await middleware(mockCtx, next, buttonConfig);

        expect(mockCooldownManager.check).toHaveBeenCalledWith('button:test.button:user123', 3000);
    });
});
