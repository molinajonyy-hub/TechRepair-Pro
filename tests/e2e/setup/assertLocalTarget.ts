// ============================================================================
// M7 7D.2 — Guard de destino E2E. FAIL-CLOSED, NO OPCIONAL.
//
// ┌── POR QUÉ EXISTE ────────────────────────────────────────────────────────┐
// │ `playwright.config.ts` arranca la app con `npx vite build`, que corre en │
// │ modo PRODUCTION y por lo tanto carga `.env` — donde VITE_SUPABASE_URL    │
// │ apunta al Supabase PRODUCTIVO. `.env.test` ni siquiera define esa        │
// │ variable, y aunque la definiera, `vite build` en modo production nunca   │
// │ la leería. Resultado: hasta 7D.2 **la suite E2E escribía en producción**.│
// └──────────────────────────────────────────────────────────────────────────┘
//
// Dos verificaciones independientes, ambas obligatorias:
//   1. DESTINO: la URL debe ser local, en un puerto permitido.
//   2. MARKER:  el backend debe tener `e2e_environment_marker` con
//      environment='e2e_local'. Un host local SIN marker NO alcanza: alguien
//      podría tunelizar producción a 127.0.0.1.
//
// No existe ningún escape tipo ALLOW_PRODUCTION_E2E. Que una configuración
// insegura falle es el comportamiento correcto.
// ============================================================================
import { loadEnv } from 'vite'

/** Puertos locales permitidos para el API de Supabase. */
const PUERTOS_PERMITIDOS = new Set(['54321', '54421', '8000', '54322'])
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export const MENSAJE_ABORTO = 'E2E ABORTADO: el destino Supabase no es local y seguro'

export interface DestinoE2E {
  supabaseUrl: string
  anonKey: string
  serviceRoleKey: string
  baseUrl: string
  email: string
  password: string
}

/**
 * Carga las variables con la MISMA semántica que Vite en `--mode e2e`.
 * El prefijo '' trae también las que no son VITE_* (service role, credenciales).
 */
export function cargarEnvE2E(root: string = process.cwd()): Record<string, string> {
  return loadEnv('e2e', root, '')
}

/** Devuelve el motivo del rechazo, o null si el destino es aceptable. */
export function motivoDeRechazo(url: string | undefined): string | null {
  if (url === undefined || url === null || !String(url).trim()) {
    return 'No se pudo determinar el destino: VITE_SUPABASE_URL está vacía o ausente en el modo e2e. ' +
      'Fail-closed: se aborta en vez de arriesgar una escritura en producción. ' +
      'Copiá .env.e2e.example a .env.e2e con los datos de `npx supabase status`.'
  }

  let u: URL
  try {
    u = new URL(String(url))
  } catch {
    return `VITE_SUPABASE_URL no es una URL válida: "${enmascarar(String(url))}".`
  }

  // Cualquier dominio gestionado de Supabase queda fuera, sin excepciones.
  if (u.hostname.endsWith('.supabase.co') || u.hostname.endsWith('.supabase.in')) {
    return `El destino es un Supabase gestionado (${enmascarar(u.hostname)}). ` +
      'Los E2E escriben datos: jamás deben correr contra un proyecto remoto. ' +
      'Apuntá VITE_SUPABASE_URL al stack local (npx supabase status).'
  }

  if (!HOSTS_LOCALES.has(u.hostname)) {
    return `El host "${enmascarar(u.hostname)}" no es local. ` +
      `Permitidos: ${[...HOSTS_LOCALES].join(', ')}.`
  }

  const puerto = u.port || (u.protocol === 'https:' ? '443' : '80')
  if (!PUERTOS_PERMITIDOS.has(puerto)) {
    return `El puerto ${puerto} no está entre los locales permitidos ` +
      `(${[...PUERTOS_PERMITIDOS].join(', ')}). Si tu stack usa otro, agregalo acá a propósito.`
  }

  return null
}

/** Enmascara para no filtrar hosts/tokens completos en logs. */
export function enmascarar(s: string): string {
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-6)}`
}

/** Verifica el MARKER contra el backend. Sin marker → aborta. */
export async function verificarMarker(supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  if (!serviceRoleKey?.trim()) {
    return 'Falta SUPABASE_SERVICE_ROLE_KEY en el modo e2e: no se puede verificar el marker del entorno. ' +
      'Fail-closed.'
  }
  let resp: Response
  try {
    resp = await fetch(`${supabaseUrl}/rest/v1/e2e_environment_marker?select=environment,project,destructive_tests_allowed&id=eq.1`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    })
  } catch (e) {
    return `No se pudo consultar el marker en ${enmascarar(supabaseUrl)}: ${(e as Error).message}. ` +
      '¿Está levantado el Supabase local? (npx supabase start)'
  }

  if (resp.status === 404 || resp.status === 400) {
    return 'El backend NO tiene la tabla e2e_environment_marker. ' +
      'Un host local sin marker NO alcanza como prueba de destino seguro. ' +
      'Ejecutá `npm run e2e:prepare` contra el stack local.'
  }
  if (!resp.ok) {
    return `El backend respondió ${resp.status} al verificar el marker. Fail-closed.`
  }

  const filas = (await resp.json()) as { environment?: string; project?: string; destructive_tests_allowed?: boolean }[]
  const m = filas?.[0]
  if (!m) return 'La tabla marker existe pero está VACÍA. Fail-closed.'
  if (m.environment !== 'e2e_local') {
    return `El marker dice environment="${m.environment}", se esperaba "e2e_local". Fail-closed.`
  }
  if (m.destructive_tests_allowed !== true) {
    return 'El marker no habilita tests destructivos (destructive_tests_allowed=false). Fail-closed.'
  }
  return null
}

/** Aborta el proceso si el destino no es local Y marcado. */
export async function assertDestinoLocalSeguro(root: string = process.cwd()): Promise<DestinoE2E> {
  const env = cargarEnvE2E(root)
  const supabaseUrl = env.VITE_SUPABASE_URL

  const motivoUrl = motivoDeRechazo(supabaseUrl)
  if (motivoUrl) abortar(motivoUrl)

  const motivoMarker = await verificarMarker(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY)
  if (motivoMarker) abortar(motivoMarker)

  return {
    supabaseUrl,
    anonKey: env.VITE_SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    baseUrl: env.E2E_BASE_URL ?? 'http://localhost:5173',
    email: env.E2E_EMAIL ?? 'e2e-owner@e2e.local',
    password: env.E2E_PASSWORD ?? '',
  }
}

function abortar(motivo: string): never {
  console.error('\n' + '═'.repeat(72))
  console.error(MENSAJE_ABORTO)
  console.error('═'.repeat(72))
  console.error(motivo)
  console.error('═'.repeat(72) + '\n')
  process.exit(1)
}
