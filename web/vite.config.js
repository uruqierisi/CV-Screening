import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server, proxy and test runner.
 *
 * **The proxy is load-bearing and it is here rather than in the API.** The
 * server registers no CORS plugin, and phase 5 may not change `server/`. A proxy
 * means the browser only ever sees same-origin requests, so no preflight, no
 * `Access-Control-Allow-Origin`, and - the part that matters beyond development -
 * `web/src/api/` builds every URL as a root-relative path. Deployed behind one
 * origin, that is already correct; deployed behind two, it is one proxy rule
 * rather than an environment variable baked into a bundle.
 *
 * `VITE_API_ORIGIN` overrides the proxy target for anyone running the API on a
 * different port. It is a dev-server setting, not a secret, and it never reaches
 * the client bundle.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
