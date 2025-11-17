import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MiddlewareChain } from '../../core/MiddlewareChain.js';

describe('MiddlewareChain', () => {
    let chain;
    let mockCtx;
    let mockConfig;

    beforeEach(() => {
        chain = new MiddlewareChain();
        mockCtx = { user: { id: 'user123' } };
        mockConfig = { id: 'test.command' };
    });

    describe('use', () => {
        it('应该添加中间件', () => {
            const middleware = vi.fn();
            chain.use(middleware);

            expect(chain.middlewares).toContain(middleware);
        });

        it('应该按顺序添加多个中间件', () => {
            const mw1 = vi.fn();
            const mw2 = vi.fn();
            const mw3 = vi.fn();

            chain.use(mw1);
            chain.use(mw2);
            chain.use(mw3);

            expect(chain.middlewares).toEqual([mw1, mw2, mw3]);
        });
    });

    describe('execute', () => {
        it('应该按顺序执行所有中间件', async () => {
            const executionOrder = [];

            const mw1 = async (ctx, next) => {
                executionOrder.push('mw1-before');
                await next();
                executionOrder.push('mw1-after');
            };

            const mw2 = async (ctx, next) => {
                executionOrder.push('mw2-before');
                await next();
                executionOrder.push('mw2-after');
            };

            const handler = async () => {
                executionOrder.push('handler');
            };

            chain.use(mw1);
            chain.use(mw2);

            await chain.execute(mockCtx, mockConfig, handler);

            expect(executionOrder).toEqual([
                'mw1-before',
                'mw2-before',
                'handler',
                'mw2-after',
                'mw1-after'
            ]);
        });

        it('应该传递ctx和config到中间件', async () => {
            let receivedCtx, receivedConfig;

            const middleware = async (ctx, next, config) => {
                receivedCtx = ctx;
                receivedConfig = config;
                await next();
            };

            chain.use(middleware);
            await chain.execute(mockCtx, mockConfig, async () => {});

            expect(receivedCtx).toBe(mockCtx);
            expect(receivedConfig).toBe(mockConfig);
        });

        it('应该在所有中间件执行后调用handler', async () => {
            const handler = vi.fn();
            const middleware = async (ctx, next) => await next();

            chain.use(middleware);
            await chain.execute(mockCtx, mockConfig, handler);

            expect(handler).toHaveBeenCalled();
        });

        it('应该在中间件不调用next时停止执行链', async () => {
            let handlerCalled = false;

            const mw1 = async (ctx, next) => {
                // 不调用next，阻止后续执行
            };

            const mw2 = vi.fn();
            const handler = () => {
                handlerCalled = true;
            };

            chain.use(mw1);
            chain.use(mw2);

            await chain.execute(mockCtx, mockConfig, handler);

            expect(mw2).not.toHaveBeenCalled();
            expect(handlerCalled).toBe(false);
        });

        it('应该传播错误', async () => {
            const error = new Error('Middleware error');

            const middleware = async () => {
                throw error;
            };

            chain.use(middleware);

            await expect(
                chain.execute(mockCtx, mockConfig, async () => {})
            ).rejects.toThrow('Middleware error');
        });

        it('应该抛出错误当next被多次调用', async () => {
            const middleware = async (ctx, next) => {
                await next();
                await next(); // 非法的第二次调用
            };

            chain.use(middleware);

            await expect(
                chain.execute(mockCtx, mockConfig, async () => {})
            ).rejects.toThrow('next() 被多次调用');
        });

        it('应该支持空中间件链', async () => {
            const handler = vi.fn();

            await chain.execute(mockCtx, mockConfig, handler);

            expect(handler).toHaveBeenCalled();
        });

        it('应该允许中间件修改ctx', async () => {
            const middleware = async (ctx, next) => {
                ctx.modified = true;
                await next();
            };

            const handler = vi.fn();

            chain.use(middleware);
            await chain.execute(mockCtx, mockConfig, handler);

            expect(mockCtx.modified).toBe(true);
            expect(handler).toHaveBeenCalledWith();
        });

        it('应该支持异步中间件', async () => {
            const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            const middleware = async (ctx, next) => {
                await delay(10);
                ctx.delayed = true;
                await next();
            };

            const handler = vi.fn();

            chain.use(middleware);
            await chain.execute(mockCtx, mockConfig, handler);

            expect(mockCtx.delayed).toBe(true);
            expect(handler).toHaveBeenCalled();
        });
    });

    describe('constructor', () => {
        it('应该接受初始中间件数组', () => {
            const mw1 = vi.fn();
            const mw2 = vi.fn();
            const chainWithMiddleware = new MiddlewareChain([mw1, mw2]);

            expect(chainWithMiddleware.middlewares).toEqual([mw1, mw2]);
        });

        it('应该默认使用空数组', () => {
            const emptyChain = new MiddlewareChain();
            expect(emptyChain.middlewares).toEqual([]);
        });
    });
});

