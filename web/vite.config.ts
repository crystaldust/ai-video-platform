// 前端构建：产物在 dist/，由 `cli serve` 静态托管。开发时 `pnpm dev` 把 /api 代理到本地服务（先 `cli serve --open no`）。
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env['AVP_API'] ?? 'http://127.0.0.1:5170';

export default defineConfig({
  plugins: [react()],
  server: {
    // 本地服务校验 Host：代理时改写成目标地址
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
