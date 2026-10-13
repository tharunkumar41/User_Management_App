import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API, uploaded files and the Socket.IO websocket to the Node server,
// so the browser sees one origin and httpOnly cookies just work.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        timeout: 300000,
        proxyTimeout: 300000,
      },
      '/uploads': {
        target: 'http://localhost:5000',
        timeout: 300000,
        proxyTimeout: 300000,
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
      },
    },
  },
});
