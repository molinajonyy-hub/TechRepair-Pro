// ============================================================================
// M7 7D.2 — globalSetup de Playwright.
//
// Corre UNA vez, ANTES de cualquier proyecto, spec o fixture. Es el punto donde
// se prueba —no se asume— que el destino es local. Si algo no cierra, corta el
// proceso: una suite que no arranca es infinitamente mejor que una suite que
// escribe en producción.
//
// Orden deliberado:
//   1. Guard de destino (URL local + marker en el backend).
//   2. Verificación del bundle REALMENTE servido a Playwright. El paso 1 lee
//      .env.e2e; esto lee lo que el browser va a recibir. No es lo mismo: el
//      bug original de 7D.1 fue exactamente esa brecha (el .env.test decía una
//      cosa y `vite build` horneaba otra).
//   3. Seed idempotente + control multi-tenant.
//   4. storageState con login real.
// ============================================================================
import type { FullConfig } from '@playwright/test'
import { chromium } from '@playwright/test'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { dirname } from 'path'
import { assertDestinoLocalSeguro, motivoDeRechazo, enmascarar, MENSAJE_ABORTO, type DestinoE2E }
  from './assertLocalTarget'
import { sembrarE2E, verificarAislamiento } from './seedE2E'

export const STORAGE_STATE = 'tests/e2e/.auth/owner.json'

function abortar(motivo: string): never {
  console.error('\n' + '═'.repeat(72))
  console.error(MENSAJE_ABORTO)
  console.error('═'.repeat(72))
  console.error(motivo)
  console.error('═'.repeat(72) + '\n')
  process.exit(1)
}

/**
 * PASO 2 — La verificación que de verdad importa.
 *
 * Abre la app servida y le pregunta al cliente Supabase YA CONSTRUIDO a qué URL
 * apunta. Si el bundle quedó horneado con `.env` productivo (el bug de 7D.1),
 * acá se detecta, aunque `.env.e2e` sea perfecto.
 */
async function verificarBundleServido(baseUrl: string, esperado: string): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage()

  // Red de seguridad adicional: si el bundle intenta hablar con un Supabase
  // gestionado, lo vemos acá aunque la introspección fallara.
  const fugas: string[] = []
  page.on('request', r => {
    const h = new URL(r.url()).hostname
    if (h.endsWith('.supabase.co') || h.endsWith('.supabase.in')) fugas.push(r.url())
  })

  let efectiva: string | null = null
  try {
    await page.goto(`${baseUrl}/landing`, { waitUntil: 'networkidle', timeout: 60_000 })
    // El módulo expone la URL efectiva para introspección (ver src/lib/supabase.ts).
    efectiva = await page.evaluate(() => (window as unknown as { __E2E_SUPABASE_URL__?: string }).__E2E_SUPABASE_URL__ ?? null)
  } catch (e) {
    await browser.close()
    abortar(`No se pudo inspeccionar la app servida en ${baseUrl}: ${(e as Error).message}`)
  }
  await browser.close()

  if (fugas.length > 0) {
    abortar(
      `La app servida hizo ${fugas.length} request(s) a un Supabase GESTIONADO. ` +
      `Primera: ${enmascarar(fugas[0])}. El bundle está apuntando a un proyecto remoto.`,
    )
  }

  if (!efectiva) {
    abortar(
      'La app servida no expone __E2E_SUPABASE_URL__: no se puede PROBAR contra qué backend ' +
      'está construida. Fail-closed — no alcanza con que .env.e2e esté bien, hay que verificar ' +
      'el bundle real. Revisá que src/lib/supabase.ts publique la URL cuando MODE === "e2e".',
    )
  }

  const motivo = motivoDeRechazo(efectiva)
  if (motivo) {
    abortar(
      `EL BUNDLE SERVIDO APUNTA A UN DESTINO NO SEGURO.\n` +
      `  URL horneada en el bundle: ${enmascarar(efectiva)}\n` +
      `  Motivo: ${motivo}\n` +
      `Esto es exactamente el bug de 7D.1: el .env leído por el guard y el .env horneado por ` +
      `\`vite build\` no coinciden. Verificá que el servidor arranque con \`--mode e2e\`.`,
    )
  }

  if (efectiva !== esperado) {
    abortar(
      `El bundle apunta a ${enmascarar(efectiva)} pero .env.e2e declara ${enmascarar(esperado)}. ` +
      `Ambos son locales, pero la discrepancia significa que el build no tomó .env.e2e: ` +
      `no hay garantía de que el resto de la configuración sea la esperada.`,
    )
  }

  console.log(`  ✓ Bundle servido verificado: apunta a ${enmascarar(efectiva)} (local, con marker).`)
}

async function crearStorageState(d: DestinoE2E): Promise<void> {
  // Se regenera siempre: la DB puede haberse reseteado y un storageState viejo
  // apuntaría a un usuario inexistente, fallando de forma confusa.
  if (existsSync(STORAGE_STATE)) rmSync(STORAGE_STATE)
  mkdirSync(dirname(STORAGE_STATE), { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  try {
    await page.goto(`${d.baseUrl}/login`, { waitUntil: 'networkidle' })
    await page.getByTestId('login-email').fill(d.email)
    await page.getByTestId('login-password').fill(d.password)
    await page.getByTestId('login-submit').click()
    // Login real: se espera salir de /login, sin simular sesión ni inyectar tokens.
    await page.waitForURL(u => !u.pathname.includes('/login'), { timeout: 20_000 })
    // /no-business significa que Auth aceptó las credenciales pero el perfil no
    // resuelve un negocio. Es un fallo del seed, no del login: hay que distinguirlo
    // o se depura a ciegas.
    if (page.url().includes('/no-business')) {
      throw new Error(
        'El login funcionó pero la app redirigió a /no-business: el perfil del usuario E2E no resuelve un negocio. ' +
        'Revisar que profiles.id = auth.uid() (no user_id) en el seed.',
      )
    }
    await page.context().storageState({ path: STORAGE_STATE })
  } catch (e) {
    await browser.close()
    abortar(
      `El login real del usuario E2E falló: ${(e as Error).message}\n` +
      'El seed corrió bien, así que revisá el formulario de /login o las credenciales de .env.e2e. ' +
      'No se simula la sesión: si el login no funciona, los E2E no prueban nada.',
    )
  }
  await browser.close()
  console.log('  ✓ storageState generado con login real.')
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  console.log('\n─── M7 7D.2 · setup E2E local ' + '─'.repeat(41))

  // 1. Destino
  const destino = await assertDestinoLocalSeguro()
  console.log(`  ✓ Destino local con marker: ${enmascarar(destino.supabaseUrl)}`)

  // 2. Bundle realmente servido
  const baseUrl = config.projects[0]?.use?.baseURL ?? destino.baseUrl
  await verificarBundleServido(String(baseUrl), destino.supabaseUrl)

  // 3. Seed + aislamiento
  await sembrarE2E(destino)
  console.log('  ✓ Seed idempotente aplicado.')
  await verificarAislamiento(destino)
  console.log('  ✓ Control multi-tenant: el usuario E2E no ve el negocio ajeno.')

  // 4. Sesión
  await crearStorageState({ ...destino, baseUrl: String(baseUrl) })

  console.log('─'.repeat(72) + '\n')
}
