/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_APP_VERSION?: string
  // Analítica de la landing (todas opcionales; no-op si faltan)
  readonly VITE_GA_MEASUREMENT_ID?: string
  readonly VITE_CLARITY_PROJECT_ID?: string
  // Contacto público de la landing (opcionales; el enlace no se renderiza si falta)
  readonly VITE_CONTACT_WHATSAPP?: string
  readonly VITE_CONTACT_EMAIL?: string
  readonly VITE_CONTACT_INSTAGRAM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __BUILD_TIME__: string
declare const __BUILD_COMMIT__: string
