import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  root: 'frontend',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3022',
      '/events': 'http://127.0.0.1:3022',
    },
  },
});
