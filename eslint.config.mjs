// ESLint v9 flat config for Arbiter.
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // dashboard globals defined by preceding same-origin scripts
        arbiterApi: 'readonly',
        arbiterApp: 'readonly',
        arbiterI18n: 'readonly',
        arbiterSse: 'readonly',
        escapeHtml: 'readonly', // shared HTML escaper from api.js
        // node
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        // browser
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        EventSource: 'readonly',
        FormData: 'readonly',
        location: 'readonly',
        history: 'readonly',
        prompt: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        matchMedia: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'always'],
    },
  },
  {
    // tests intentionally use stub globals (_-prefixed params) and
    // fixture reads — not a source-level quality signal
    files: ['test/**'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'data/'],
  },
];
