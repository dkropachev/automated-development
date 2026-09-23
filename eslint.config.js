'use strict'
const js = require('@eslint/js')
const globals = {
  require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
}
module.exports = [
  // workflows/ is neither a script nor a module to a parser: a Workflow script `export`s its meta
  // block AND uses top-level `return`, because the runtime wraps it in an async function. ESLint can
  // parse one or the other, never both, so it is skipped here and covered by scripts/syntax-check.js
  // instead - which is exactly what that script exists for.
  { ignores: ['node_modules/**', 'evals/results/**', 'workflows/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['bench/dashboard/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        document: 'readonly', window: 'readonly', location: 'readonly', Node: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
      },
    },
  },
]
