import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'generate-version-file',
      buildStart() {
        // Escribe public/version.json para que el poller de actualización pueda comparar
        try {
          mkdirSync(resolve(__dirname, 'public'), { recursive: true })
          writeFileSync(
            resolve(__dirname, 'public/version.json'),
            JSON.stringify({ buildTime: BUILD_TIME }),
            'utf-8'
          )
        } catch { /* ignorar en entornos read-only */ }
      },
    },
  ],
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  server: {
    port: 5173,
    open: true
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React core
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Supabase
          'supabase': ['@supabase/supabase-js'],
          // Lucide icons (muy pesado)
          'lucide': ['lucide-react'],
          // PDF / print
          'pdf': ['jspdf', 'jspdf-autotable', 'html2canvas'],
          // Excel
          'excel': ['xlsx'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
