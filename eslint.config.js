'use strict';

// Catches likely mistakes (unused or undefined names, unreachable code), not style.
// Run with `npm run lint`.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  // Express knows an error handler by its four arguments, so an unused `next` stays.
  { rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^(next|_)', caughtErrors: 'none' }] } },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node },
  },
  // The price-checker runs in Node, and hands some functions to the store's page to run there.
  {
    files: ['price-checker/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
  // The Coles button, a browser extension.
  {
    files: ['browser-extension/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser },
  },
];
