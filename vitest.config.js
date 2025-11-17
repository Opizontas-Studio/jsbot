import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // 使用Node环境
        environment: 'node',

        // 全局API（describe, it, expect等）
        globals: true,

        // 测试文件匹配模式
        include: [
            'src/tests/**/*.test.js',
            'src/tests/**/*.spec.js'
        ],

        // 排除
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/cypress/**',
            '**/.{idea,git,cache,output,temp}/**',
            '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*'
        ],

        // 覆盖率配置
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.js'],
            exclude: [
                'src/tests/**',
                '**/node_modules/**',
                '**/dist/**'
            ]
        },

        // 测试超时
        testTimeout: 10000,
        hookTimeout: 10000,

        // 并行执行
        threads: true,

        // 监听模式排除
        watchExclude: [
            '**/node_modules/**',
            '**/dist/**'
        ]
    }
});

