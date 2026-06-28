import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      // Vite static-passthrough assets — NOT lintable source. Includes the self-hosted Pixi KTX2
      // transcoder (public/transcoders/ktx/libktx.js — emscripten glue) copied for round15's no-CDN probe.
      '**/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.worker },
    },
  },
);
