import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './index.css';
import { App } from './App';
import { I18nProvider } from './lib/i18n';
import { applyTheme, loadTheme } from './lib/theme';
import { registerServiceWorker } from './lib/register-sw';

// Apply the stored display-theme once at startup. The inline <head> script (index.html) already set data-theme
// FOUC-free for a forced light/dark choice; this reconciles the 'auto' case (removes the attribute so the CSS
// @media(prefers-color-scheme) drives) after a previous forced choice was cleared. Idempotent.
applyTheme(loadTheme(), document.documentElement);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

// PWA offline shell (PROD only — a SW conflicts with Vite HMR in dev). Best-effort; see register-sw.ts.
if (import.meta.env.PROD) registerServiceWorker();
