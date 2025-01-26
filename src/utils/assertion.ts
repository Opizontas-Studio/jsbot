import { Database } from 'sqlite';

export namespace Assert {
    export function isError(error: unknown): asserts error is Error {
        if (!(error instanceof Error)) {
            throw new Error('error 必须是 Error 类型');
        }
    }

    export function isDatabase(database: Database | undefined): asserts database is Database {
        if (!(database instanceof Database)) {
            throw new Error('未连接数据库!');
        }
    }
}
