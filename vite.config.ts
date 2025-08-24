
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      'Permissions-Policy': 'xr-spatial-tracking=(self), fullscreen=(self)',
      'X-Content-Type-Options': 'nosniff'
    }
  },
  build: {
    sourcemap: true
  }
})
