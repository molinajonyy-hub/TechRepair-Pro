// ============================================================================
// M7 7D.1 — Guard de entorno para E2E.
//
// ┌── POR QUE EXISTE ────────────────────────────────────────────────────────┐
// │ `.env` del repo apunta VITE_SUPABASE_URL a la instancia PRODUCTIVA. Los  │
// │ E2E levantan la app con esa config, así que hoy, por defecto, **los      │
// │ tests E2E escriben en producción**: crean comprobantes, pagos y          │
// │ movimientos de caja reales con la cuenta QA.                            │
// │                                                                          │
// │ Este guard aborta si el Supabase que va a usar el test no es local o de  │
// │ test permitido. Es fail-closed: si no puede determinar el destino, corta.│
// └──────────────────────────────────────────────────────────────────────────┘
//
// Uso: llamarlo en el `test.beforeAll` de cualquier spec que escriba datos.
// ============================================================================

/** Hosts permitidos para E2E. Todo lo demás aborta. */
const HOSTS_PERMITIDOS = [
  /^127\.0\.0\.1(:\d+)?$/,
  /^localhost(:\d+)?$/,
  /^\[::1\](:\d+)?$/,
  /^host\.docker\.internal(:\d+)?$/,
  /^kong(:\d+)?$/,               // stack local de Supabase por docker-compose
]

/** Refs de Supabase explícitamente prohibidos (producción conocida). */
const REFS_PROHIBIDOS = ['vrdxxmjzxhfgqlnxmbwx']

export interface EnvE2E {
  supabaseUrl: string
  baseUrl: string
}

export function resolverEnvE2E(): EnvE2E {
  const supabaseUrl =
    process.env.E2E_SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    ''
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
  return { supabaseUrl, baseUrl }
}

/** Devuelve el motivo del rechazo, o null si el destino es seguro. */
export function motivoDeRechazo(supabaseUrl: string): string | null {
  if (!supabaseUrl.trim()) {
    return 'No se pudo determinar el Supabase de destino (E2E_SUPABASE_URL / VITE_SUPABASE_URL vacíos). ' +
      'Fail-closed: se aborta en vez de arriesgar escribir en producción.'
  }

  let host: string
  try {
    host = new URL(supabaseUrl).host
  } catch {
    return `URL de Supabase inválida: "${supabaseUrl}".`
  }

  for (const ref of REFS_PROHIBIDOS) {
    if (supabaseUrl.includes(ref)) {
      return `El destino es la instancia PRODUCTIVA (ref ${ref}). ` +
        'Los E2E escriben datos: jamás deben correr contra producción. ' +
        'Configurá E2E_SUPABASE_URL apuntando al Supabase local (npx supabase status).'
    }
  }

  if (!HOSTS_PERMITIDOS.some(re => re.test(host))) {
    return `El host "${host}" no es local ni de test permitido. ` +
      'Permitidos: localhost, 127.0.0.1, [::1], host.docker.internal, kong. ' +
      'Configurá E2E_SUPABASE_URL apuntando al Supabase local.'
  }

  return null
}

/**
 * Aborta el proceso de test si el destino no es local.
 * Llamar SIEMPRE antes de cualquier spec que escriba datos.
 */
export function assertEntornoLocal(): EnvE2E {
  const env = resolverEnvE2E()
  const motivo = motivoDeRechazo(env.supabaseUrl)
  if (motivo) {
    throw new Error(
      '\n╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  E2E ABORTADO: destino no permitido                              ║\n' +
      '╚══════════════════════════════════════════════════════════════════╝\n' +
      motivo + '\n'
    )
  }
  return env
}
