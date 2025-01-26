import { describe, expect, it } from '@jest/globals';
import { fromSqlited, toSqlited } from '../../src/db/sqlited.js';

describe('Sqlited', () => {
    const unwrapped = {
        number: 5,
        string: "that's it",
        boolean: false,
        array: [1, 9, 5, 2],
        object: {
            value1: 'hello',
            value2: true,
            value3: ['what', 'you', 'mean'],
        },
    };

    const wrapped = {
        number: 5,
        string: "that's it",
        boolean: JSON.stringify(false),
        array: JSON.stringify(unwrapped.array),
        object: JSON.stringify(unwrapped.object),
    };

    it('is convertible from unwrapped type', async () => {
        expect(toSqlited(unwrapped)).toStrictEqual(wrapped);
    });

    it('converts to unwrapped type', async () => {
        expect(fromSqlited<typeof unwrapped>(wrapped)).toStrictEqual(unwrapped);
    });
});
