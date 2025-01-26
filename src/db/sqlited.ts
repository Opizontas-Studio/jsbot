import { Assert } from '../utils/assertion.js';

export type Sqlited<T extends object> = {
    [key in keyof T]: T[key] extends number ? number : string;
};

export function toSqlited<T extends object>(data: T): Sqlited<T> {
    return Object.fromEntries(
        Object.entries(data).map(([field, value]) => [
            field,
            typeof value === 'number'
                ? value
                : typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object'
                ? JSON.stringify(value)
                : String(value),
        ]),
    ) as Sqlited<T>;
}

export function fromSqlited<T extends object>(data: Sqlited<T>): T {
    const transformers: Record<'number' | 'string', (value: any) => any> = {
        number: (value: number) => value,
        string: (value: string) => {
            if (
                value === 'true' ||
                value === 'false' ||
                (value.startsWith('[') && value.endsWith(']')) ||
                (value.startsWith('{') && value.endsWith('}'))
            ) {
                try {
                    return JSON.parse(value);
                } catch (error) {
                    Assert.isError(error);
                    throw Error(`JSON解析失败: ${error.message}`);
                }
            } else {
                return value;
            }
        },
    };
    return Object.fromEntries(
        Object.entries(data).map(([field, value]) => [
            field,
            transformers[typeof value as keyof typeof transformers](value),
        ]),
    ) as T;
}
