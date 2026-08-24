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
//   4. al confirmar   -> el login entra, pero el tenant TODAVÍA no existe
//   4b. camino canónico -> exactamente 1 tenant, con el nombre elegido, y el
//       reload no lo duplica
//   4c. alta estilo mayorista -> 0 tenants SaaS
//   5. el producto no es alcanzable por URL mientras tanto
//
// ⚠️ Los casos 4x cambiaron de contrato en 20260823180000 (P0-P1 fase B):
// confirmar el correo ya no provisiona. Crear el tenant es una acción explícita
// del usuario contra `provision_my_business()`.
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

test('@m7 4. al confirmar el login entra, pero el tenant TODAVIA no existe', async ({ page }) => {
  // ⚠️ CONTRATO NUEVO desde 20260823180000 (P0-P1 fase B). Este test aseveraba
  // lo contrario —que confirmar disparaba el provisioning— porque eso es lo que
  // hacía el trigger `on_auth_user_email_confirmed`. Ese acoplamiento se retiró:
  // confirmar una identidad ya no funda una empresa.
  const email = emailUnico('confirm')
  await borrarPorEmail(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })

  const id = await idDe(email)
  expect(contarProfiles(id!)).toBe(0)

  // Equivale a hacer click en el enlace del correo.
  await confirmar(email)

  // El corazón de la fase B: confirmar NO provisiona.
  expect(contarProfiles(id!), 'confirmar no debe crear un profile').toBe(0)
  expect(contarBusinesses(id!), 'confirmar no debe crear un business').toBe(0)

  // Pero el login sí entra: la cuenta quedó operativa.
  await loguearse(page, email)
  await expect(page).not.toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  await expect(page).not.toHaveURL(/\/login/, { timeout: 25_000 })

  // Y sin negocio, el guard lo lleva al embudo de creación.
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 25_000 })

  await borrarPorEmail(email)
})

test('@m7 4b. el camino canónico crea EXACTAMENTE un tenant, con el nombre elegido', async ({ page }) => {
  // El test que impide el falso verde de la fase B: apagar los triggers sin
  // esto sería indistinguible de romper el alta de owners.
  const email = emailUnico('canonico')
  const nombreNegocio = `Taller E2E ${Date.now()}`
  await borrarPorEmail(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  await confirmar(email)
  await loguearse(page, email)

  await expect(page).toHaveURL(/\/onboarding/, { timeout: 25_000 })
  const id = await idDe(email)
  expect(contarBusinesses(id!)).toBe(0)

  // Acción EXPLÍCITA de crear el taller.
  await page.getByTestId('onboarding-business-name').fill(nombreNegocio)
  await page.getByTestId('onboarding-rubro-celulares').click()
  await page.getByTestId('onboarding-step1-submit').click()

  // El paso 2 (logo) es la señal de que el paso 1 cerró bien.
  await expect(page.getByText('Logo de tu negocio')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByTestId('onboarding-error')).toHaveCount(0)

  expect(contarProfiles(id!), 'exactamente 1 profile').toBe(1)
  expect(contarBusinesses(id!), 'exactamente 1 business').toBe(1)

  // El nombre que el usuario escribió SÍ se persiste. Antes se perdía y por eso
  // 16 de 24 negocios de producción se llaman «Mi Negocio».
  const negocio = consultarJSON<{ name: string; role: string; owner_ok: boolean }>(
    `SELECT b.name, p.role, (b.owner_user_id = '${id}') AS owner_ok
       FROM public.businesses b JOIN public.profiles p ON p.business_id = b.id
      WHERE p.id = '${id}'`,
  )
  expect(negocio.name).toBe(nombreNegocio)
  expect(negocio.role).toBe('owner')
  expect(negocio.owner_ok).toBe(true)

  // RETRY: recargar el embudo no puede fabricar un segundo tenant. Con negocio
  // ya creado, el guard del wizard manda al dashboard.
  await page.goto('/onboarding')
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 25_000 })
  expect(contarBusinesses(id!), 'el reload no debe duplicar el tenant').toBe(1)

  await borrarPorEmail(email)
})

test('@m7 4c. un alta estilo mayorista NO fabrica un tenant SaaS', async ({ page: _page }) => {
  // Medido antes del lote: 2 de 2 clientes mayoristas tenían su propio negocio
  // «Mi Negocio» con rol owner y trial. El portal puede seguir creando usuarios
  // de auth; lo que no puede es fundar una empresa.
  const email = emailUnico('mayorista')
  await borrarPorEmail(email)

  const sb = await admin()
  const { error } = await sb.auth.signUp({
    email,
    password: PASSWORD,
    options: {
      data: {
        wholesale_registration: { portal_slug: 'demo', name: 'Cliente Mayorista' },
      },
    },
  })
  expect(error, 'el alta de auth debe funcionar').toBeNull()

  const id = await idDe(email)
  expect(id, 'el auth user debe existir').not.toBeNull()

  await confirmar(email)

  expect(contarProfiles(id!), 'el mayorista no debe recibir profile SaaS').toBe(0)
  expect(contarBusinesses(id!), 'el mayorista no debe recibir business SaaS').toBe(0)

  await borrarPorEmail(email)
})

test('@m7 5. sin sesión el producto no es alcanzable por URL', async ({ page }) => {
  for (const ruta of ['/dashboard', '/inventory', '/onboarding', '/no-business']) {
    await page.goto(ruta)
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.locator('.main-layout-content')).toHaveCount(0)
  }
})
