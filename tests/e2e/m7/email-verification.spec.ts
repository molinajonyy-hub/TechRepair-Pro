// ============================================================================
// EMAIL VERIFICATION P0 — el flujo real, end-to-end, con Confirm Email ENCENDIDO
// en el stack LOCAL (ver supabase/config.toml; producción no se toca).
//
// POR QUÉ HIZO FALTA ENCENDER EL FLAG EN LOCAL
// ---------------------------------------------
// MEDIDO contra GoTrue local: con `enable_confirmations = false`, un usuario
// creado sin confirmar igual recibe `400 Email not confirmed` al intentar
// loguearse. El flag gobierna el SIGNUP (lo auto-confirma), no el password
// grant. Consecuencias:
//
//   · con el flag apagado NO se puede alcanzar el estado «registro pendiente»
//     (signUp devuelve sesión), así que no hay flujo que recorrer;
//   · y tampoco se puede obtener una «sesión sin confirmar», porque GoTrue
//     nunca la emite.
//
// Ese segundo punto es un hallazgo del lote y vale anotarlo: con Confirm Email
// ON, un usuario sin confirmar NO PUEDE tener sesión por login. El guard de
// ProtectedRoute es defensa en profundidad (cubre sesiones anteriores al
// switch y bordes de OAuth), no la única barrera.
//
// Un intento anterior ponía `email_confirmed_at = NULL` por SQL reusando el
// storageState del owner: era un falso negativo. El cliente lee ese campo de
// la sesión GUARDADA, no de la base, y además «des-confirmar» no existe en el
// producto.
//
//   1. signup por UI  -> /verificar-email, sin sesión, con reenvío
//   2. sin confirmar  -> NO hay provisioning (ni profile ni business)
//   3. sin confirmar  -> el login lo dice CLARO (no «contraseña incorrecta»)
//   4. al confirmar   -> provisioning y el login entra
//   5. el producto no es alcanzable por URL mientras tanto
//
// Los correos locales se leen en Inbucket: http://127.0.0.1:54424
// ============================================================================
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'

// Sesión propia: este spec NO usa el storageState del owner.
test.use({ storageState: { cookies: [], origins: [] } })

const PASSWORD = 'e2e-pendiente-pass-123'

/** Email único por test: evita el rate limit de correos y la interferencia. */
function emailUnico(sufijo: string): string {
  return `e2e-pendiente-${sufijo}@e2e.local`
}

async function admin() {
  const d = await assertDestinoLocalSeguro()
  return createClient(d.supabaseUrl, d.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function borrarPorEmail(email: string): Promise<void> {
  const sb = await admin()
  const { data } = await sb.auth.admin.listUsers()
  const u = data?.users?.find(x => x.email === email)
  if (u) await sb.auth.admin.deleteUser(u.id).catch(() => {})
}

async function idDe(email: string): Promise<string | null> {
  const sb = await admin()
  const { data } = await sb.auth.admin.listUsers()
  return data?.users?.find(x => x.email === email)?.id ?? null
}

async function confirmar(email: string): Promise<void> {
  const sb = await admin()
  const id = await idDe(email)
  if (!id) throw new Error(`No existe el usuario ${email}`)
  const { error } = await sb.auth.admin.updateUserById(id, { email_confirm: true })
  if (error) throw new Error(`No se pudo confirmar: ${error.message}`)
}

function contarProfiles(id: string): number {
  return consultarJSON<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.profiles WHERE id = '${id}' OR user_id = '${id}'`,
  ).n
}

function contarBusinesses(id: string): number {
  return consultarJSON<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.businesses b
      JOIN public.profiles p ON p.business_id = b.id
     WHERE p.id = '${id}' OR p.user_id = '${id}'`,
  ).n
}

/** Registro por UI. */
async function registrarse(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.getByTestId('login-tab-register').click()
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.fill('[data-testid="login-confirm-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
}

/** Login por UI. */
async function loguearse(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
}

test('@m7 1. el signup por UI lleva a /verificar-email y ofrece reenviar', async ({ page }) => {
  const email = emailUnico('signup')
  await borrarPorEmail(email)

  await registrarse(page, email)

  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  await expect(page.getByTestId('verify-email-page')).toBeVisible()
  // Funciona SIN sesión: es el estado real tras un signup con Confirm ON.
  await expect(page.getByTestId('verify-email-reenviar')).toBeEnabled()
  await expect(page.getByTestId('verify-email-address')).toBeVisible()

  await borrarPorEmail(email)
})

test('@m7 2. sin confirmar NO hay provisioning', async ({ page }) => {
  const email = emailUnico('noprov')
  await borrarPorEmail(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })

  const id = await idDe(email)
  expect(id, 'el auth user debe existir').not.toBeNull()

  // El corazón de la P0: el usuario existe pero no consumió un tenant.
  expect(contarProfiles(id!)).toBe(0)
  expect(contarBusinesses(id!)).toBe(0)

  await borrarPorEmail(email)
})

test('@m7 3. el login sin confirmar lo dice claro, no "contraseña incorrecta"', async ({ page }) => {
  const email = emailUnico('login')
  await borrarPorEmail(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })

  await loguearse(page, email)

  // El bug que esta P0 corrige: antes decía «Email o contraseña incorrectos».
  const alerta = page.getByRole('alert')
  await expect(alerta).toBeVisible({ timeout: 20_000 })
  await expect(alerta).toContainText(/no está confirmada|confirmada/i)
  await expect(alerta).not.toContainText(/contraseña incorrect/i)
  // Y se ofrece la salida: reenviar el correo.
  await expect(page.getByTestId('login-resend-confirmation')).toBeVisible()

  await borrarPorEmail(email)
})

test('@m7 4. al confirmar hay provisioning y el login entra', async ({ page }) => {
  const email = emailUnico('confirm')
  await borrarPorEmail(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })

  const id = await idDe(email)
  expect(contarProfiles(id!)).toBe(0)

  // Equivale a hacer click en el enlace del correo.
  await confirmar(email)

  // El trigger de confirmación corrió: exactamente un profile y un business.
  expect(contarProfiles(id!)).toBe(1)
  expect(contarBusinesses(id!)).toBe(1)

  await loguearse(page, email)

  await expect(page).not.toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  await expect(page).not.toHaveURL(/\/login/, { timeout: 25_000 })

  await borrarPorEmail(email)
})

test('@m7 5. sin sesión el producto no es alcanzable por URL', async ({ page }) => {
  for (const ruta of ['/dashboard', '/inventory', '/onboarding', '/no-business']) {
    await page.goto(ruta)
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.locator('.main-layout-content')).toHaveCount(0)
  }
})
