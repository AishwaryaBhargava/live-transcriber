// eslint.config.js (flat config for ESLint v9)

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  // Ignore stuff
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'extension/build/',
      'extension/**/*.min.js',
      '**/.DS_Store',
    ],
  },

  // Base recommended rules
  js.configs.recommended,

  // Backend (Node / CommonJS)
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': 'off',
      // <— allow `catch {}` blocks to be empty
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Extension (browser / ES modules)
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': 'off',
      // <— allow `catch {}` blocks to be empty
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Disable style rules that conflict with Prettier
  prettierConfig,
];
