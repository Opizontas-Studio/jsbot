import { DiscordAPIError } from '@discordjs/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { errorHandlerMiddleware, formatErrorMessage } from '../../../core/middleware/errorHandler.js';

describe('errorHandler middleware', () => {
    let mockLogger;
    let mockCtx;
    let next;

    beforeEach(() => {
        mockLogger = {
            error: vi.fn()
        };

        mockCtx = {
            user: { id: 'user123' },
            guild: { id: 'guild123' },
            interaction: { type: 'COMMAND' },
            error: vi.fn().mockResolvedValue({})
        };

        next = vi.fn().mockResolvedValue({});
    });

    it('应该在无错误时正常执行', async () => {
        const middleware = errorHandlerMiddleware(mockLogger);

        await middleware(mockCtx, next);

        expect(next).toHaveBeenCalled();
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockCtx.error).not.toHaveBeenCalled();
    });

    it('应该捕获并记录错误', async () => {
        const error = new Error('Test error');
        next.mockRejectedValue(error);

        const middleware = errorHandlerMiddleware(mockLogger);

        await middleware(mockCtx, next);

        expect(mockLogger.error).toHaveBeenCalledWith({
            msg: '交互处理错误',
            userId: 'user123',
            guildId: 'guild123',
            interaction: 'COMMAND',
            error: 'Test error',
            stack: expect.any(String)
        });
    });

    it('应该回复格式化的错误消息', async () => {
        const error = new Error('Test error');
        next.mockRejectedValue(error);

        const middleware = errorHandlerMiddleware(mockLogger);

        await middleware(mockCtx, next);

        expect(mockCtx.error).toHaveBeenCalledWith(expect.any(String), true);
    });

    it('应该处理回复错误的情况', async () => {
        const error = new Error('Test error');
        next.mockRejectedValue(error);
        mockCtx.error.mockRejectedValue(new Error('Reply failed'));

        const middleware = errorHandlerMiddleware(mockLogger);

        await middleware(mockCtx, next);

        expect(mockLogger.error).toHaveBeenCalledWith({
            msg: '发送错误回复失败',
            error: 'Reply failed'
        });
    });
});

describe('formatErrorMessage', () => {
    it('应该格式化Discord API错误', () => {
        const apiError = new DiscordAPIError(
            { message: 'Unknown Channel', code: RESTJSONErrorCodes.UnknownChannel },
            RESTJSONErrorCodes.UnknownChannel,
            404,
            'GET',
            '/channels/123',
            {}
        );

        const message = formatErrorMessage(apiError);
        expect(message).toBe('频道不存在或无法访问');
    });

    it('应该处理缺少权限错误', () => {
        const apiError = new DiscordAPIError(
            { message: 'Missing Permissions', code: RESTJSONErrorCodes.MissingPermissions },
            RESTJSONErrorCodes.MissingPermissions,
            403,
            'POST',
            '/channels/123/messages',
            {}
        );

        const message = formatErrorMessage(apiError);
        expect(message).toBe('缺少所需权限');
    });

    it('应该处理BusinessError', () => {
        const businessError = new Error('自定义业务错误');
        businessError.name = 'BusinessError';

        const message = formatErrorMessage(businessError);
        expect(message).toBe('自定义业务错误');
    });

    it('应该处理超时错误', () => {
        const timeoutError = new Error('Request timeout');

        const message = formatErrorMessage(timeoutError);
        expect(message).toBe('操作超时，请稍后重试');
    });

    it('应该处理网络连接错误', () => {
        const networkError = new Error('Network error');
        networkError.code = 'ECONNRESET';

        const message = formatErrorMessage(networkError);
        expect(message).toBe('网络连接失败，请稍后重试');
    });

    it('应该返回通用错误消息对于未知错误', () => {
        const unknownError = new Error('Some random error');

        const message = formatErrorMessage(unknownError);
        expect(message).toBe('发生未知错误，请稍后重试或联系管理员');
    });

    it('应该处理交互已确认错误', () => {
        const apiError = new DiscordAPIError(
            {
                message: 'Interaction has already been acknowledged',
                code: RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged
            },
            RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
            400,
            'POST',
            '/interactions/123/callback',
            {}
        );

        const message = formatErrorMessage(apiError);
        expect(message).toBe('交互已确认');
    });

    it('应该处理内容超长错误', () => {
        const apiError = new DiscordAPIError(
            {
                message: 'Request entity too large',
                code: RESTJSONErrorCodes.RequestEntityTooLarge
            },
            RESTJSONErrorCodes.RequestEntityTooLarge,
            413,
            'POST',
            '/channels/123/messages',
            {}
        );

        const message = formatErrorMessage(apiError);
        expect(message).toBe('内容超出长度限制');
    });
});
