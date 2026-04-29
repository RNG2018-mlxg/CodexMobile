import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3321',
      '/ws': {
        target: 'ws://127.0.0.1:3321',
        ws: true
      }
    }
  }
});
