import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

const BUILD_TIME = new Date().toISOString()

// Hash corto del commit para identificar el build en runtime (no es secreto).
// En local usa git; en Vercel cae al SHA que provee el entorno.
function resolveBuildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || ''
    return sha ? sha.slice(0, 7) : 'dev'
  }
}
const BUILD_COMMIT = resolveBuildCommit()

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
          source: JSON.stringify({ buildTime: BUILD_TIME, commit: BUILD_COMMIT }),
        })
      },
    },
  ],
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
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
