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
      // The service-worker TEMPLATE (P5 PWA): valid JS only after scripts/pwa-plugin.mjs substitutes the
      // __SW_VERSION__ / __SW_PRECACHE__ placeholders at build; the emitted dist/sw.js is real (and covered
      // by the offline e2e). Linting the template flags the placeholders as undefined identifiers.
      '**/sw.template.js',
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
