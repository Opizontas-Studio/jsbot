/**
 * 中间件管道
 * @module kernel/Pipeline
 */

import type { Context } from '@/kernel/Context.js';
import type { InteractionConfig } from '../types/config.js';

export type Next = () => Promise<void>;

export type Middleware<T extends Context = Context> = (ctx: T, next: Next, config: InteractionConfig) => Promise<void>;

export interface MiddlewareEntry<T extends Context = Context> {
    name: string;
    fn: Middleware<T>;
}

export class Pipeline<T extends Context = Context> {
    private middlewares: MiddlewareEntry<T>[] = [];

    use(middleware: Middleware<T>, name?: string): this {
        this.middlewares.push({
            name: name ?? middleware.name ?? `mw_${this.middlewares.length}`,
            fn: middleware
        });
        return this;
    }

    names(): string[] {
        return this.middlewares.map(m => m.name);
    }

    async execute(ctx: T, config: InteractionConfig, handler: () => Promise<void>): Promise<void> {
        let index = 0;

        const next: Next = async () => {
            if (index < this.middlewares.length) {
                const mw = this.middlewares[index++]!;
                await mw.fn(ctx, next, config);
            } else {
                await handler();
            }
        };

        await next();
    }
}
