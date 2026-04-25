import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
