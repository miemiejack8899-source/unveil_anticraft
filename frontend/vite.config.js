import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 独立项目：前端 3100，后端 8100（避开 anticraft 的 3000/8000，两者可同时运行）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
    },
  },
})
