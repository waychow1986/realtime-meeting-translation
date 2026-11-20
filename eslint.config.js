import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.ai-delivery/**', 'infra/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/server/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/web/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'element', property: 'innerHTML', message: '字幕只能以 textContent 渲染' },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['debug', 'error'] }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
