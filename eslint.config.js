import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    // enable it afterwards
    // tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            // parserOptions: {
            //   projectService: true,
            //   tsconfigRootDir: import.meta.dirname,
            // },
        },
        rules: {
            'handle-callback-err': 'off',
            'no-console': 'off',
            'no-empty-function': 'error',
            'no-floating-decimal': 'error',
            'no-lonely-if': 'error',
            'no-multi-spaces': 'error',
            'no-shadow': ['error', { allow: ['err', 'resolve', 'reject'] }],
            'no-var': 'error',
            'no-undef': 'off',
            'prefer-const': 'error',
            yoda: 'error',
        },
    },
    eslintConfigPrettier,
);
