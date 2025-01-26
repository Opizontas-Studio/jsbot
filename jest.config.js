import { createJsWithTsPreset } from 'ts-jest';

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
    ...createJsWithTsPreset(),
    testEnvironment: 'node',
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
};
