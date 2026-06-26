import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Relative base on build so the app works under a GitHub Pages project subpath
// (https://user.github.io/<repo>/); root base in dev.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react(), tailwindcss()],
  // ES-format workers so the fix worker can lazy `import('@jsquash/avif')` (the default inlines
  // dynamic imports, which can't code-split).
  worker: { format: 'es' },
  // @jsquash ships WASM that the fix worker lazy-imports; don't pre-bundle it.
  optimizeDeps: { exclude: ['@jsquash/avif', '@jsquash/webp'] },
}));
