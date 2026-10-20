import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // ServiceNow instance-side scripts run in the platform's Rhino/ES5-ish engine
    files: ['servicenow/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        gs: 'readonly',
        GlideRecord: 'readonly',
        GlideDateTime: 'readonly',
        GlideCertificateEncryption: 'readonly',
        answer: 'writable',
        sn_ws: 'readonly',
        source: 'readonly',
        target: 'readonly',
        action: 'writable',
        ignore: 'writable',
        error: 'writable',
        error_message: 'writable',
        log: 'readonly',
        map: 'readonly',
        request: 'readonly',
        response: 'readonly',
        global: 'readonly',
      },
    },
    rules: { 'no-var': 'off', 'prefer-const': 'off', 'no-unused-vars': 'off', eqeqeq: 'off' },
  },
];
