import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'generate-version-file',
      // generateBundle corre solo en `vite build` y emite el archivo directo a dist/
      // sin necesitar __dirname ni escribir en public/ (que está en git)
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildTime: BUILD_TIME }),
        })
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
