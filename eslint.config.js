module.exports = [
  {
    files: ['extension.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-useless-escape': 'error'
    }
  }
];
