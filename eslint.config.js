'use strict'
const js = require('@eslint/js')
const globals = {
  require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
}
module.exports = [
  { ignores: ['node_modules/**', 'evals/results/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
