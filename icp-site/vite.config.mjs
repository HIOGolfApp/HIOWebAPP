// Client build: web/index.html + src/app/** -> dist/client (served by nginx, see ../nginx/hiogolf-site.conf).
// Hashed bundles go to /icp-assets/ so they cannot collide with the main site's files.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  publicDir: '../src/public',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    assetsDir: 'icp-assets',
    sourcemap: false,
  },
  // npx vite (dev) with `node dist/server.mjs` running alongside
  server: { proxy: { '/api': 'http://127.0.0.1:3100' } },
});
