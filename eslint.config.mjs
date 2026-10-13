import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import prettier from 'eslint-config-prettier/flat';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';

export default defineConfig([
  globalIgnores(['.local/**', 'node_modules/**', 'test-results/**']),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended, comments.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
    // Every lint exception must state its reason next to the code it exempts.
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      // Playwright fixture dependency injection requires an object parameter, even when empty.
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    },
  },
  prettier,
]);
