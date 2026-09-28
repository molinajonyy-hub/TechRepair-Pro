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
//   PRE-BETA-2D — el CORREO real (plantilla token_hash versionada, la que 2E
//   deja en producción), sin atajos de la admin API:
//   6. signup → correo → escáner (GET) → click en OTRA pestaña → confirmado,
//      /no-business; la pestaña original avanza sola
//   7. el enlace de alta YA USADO nunca cae en la pantalla de recovery
//   8. GoTrue degradó el redirect al Site URL: `/?token_hash=…&type=signup`
//      igual confirma (fallback de la raíz)
//   9. política: 7 caracteres no se registran; `error_description` no se pinta
//
// ⚠️ Los casos 4x cambiaron de contrato en 20260823180000 (P0-P1 fase B):
// confirmar el correo ya no provisiona. Crear el tenant es una acción explícita
// del usuario contra `provision_my_business()`.
//
// Los correos locales se leen en Mailpit ([local_smtp] de supabase/config.toml).
// ============================================================================
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'
import { borrarCorreos, esEnlaceTokenHash, esperarEnlace, ultimoCorreo } from '../setup/mailpit.ts'

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

  // Y sin negocio, el guard lo lleva al RECOVERY.
  //
  // ⚠️ CONTRATO NUEVO desde 20260825120000 (P0-P4). Antes el destino era
  // /onboarding, porque el paso 1 del wizard era el que creaba el tenant. Ahora
  // el onboarding CONFIGURA un negocio que ya existe y no puede crear ninguno,
  // así que el alta vive en /no-business detrás de un click explícito.
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })
  await expect(page.getByTestId('no-business-create')).toBeVisible()

  // Y montar esa pantalla no crea nada por su cuenta.
  expect(contarBusinesses(id!), 'el recovery no provisiona al montarse').toBe(0)

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

  // P0-P4: el alta explícita vive en /no-business, no en el paso 1 del wizard.
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })
  const id = await idDe(email)
  expect(contarBusinesses(id!)).toBe(0)

  // Acción EXPLÍCITA de crear el taller.
  await page.getByTestId('no-business-name').fill(nombreNegocio)
  await page.getByTestId('no-business-crear').click()

  // Llegar al onboarding es la señal de que el alta cerró bien.
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 25_000 })
  await expect(page.getByTestId('no-business-error')).toHaveCount(0)

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

  // RETRY: volver al recovery no puede fabricar un segundo tenant. Con negocio
  // ya creado, esa pantalla manda al dashboard.
  await page.goto('/no-business')
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 25_000 })
  expect(contarBusinesses(id!), 'volver al recovery no debe duplicar el tenant').toBe(1)

  // Y el onboarding queda disponible como CONFIGURACIÓN del negocio existente,
  // sin volver a crear nada.
  await page.goto('/onboarding')
  await expect(page.getByTestId('onboarding-business-name')).toBeVisible({ timeout: 25_000 })
  expect(contarBusinesses(id!), 'configurar no duplica el tenant').toBe(1)

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

// ── PRE-BETA-2D — el correo real, con la plantilla token_hash ──────────────

/** Enlace de confirmación del correo local (contrato de supabase/templates/confirmation.html). */
const enlaceDeAlta = (email: string) => esperarEnlace(email, esEnlaceTokenHash('signup'))

test('@m7 6. alta real por correo: escáner + click en otra pestaña → confirmada y en /no-business, sin provisionar', async ({ page, context, baseURL }) => {
  const email = emailUnico(`correo-${Date.now()}`)
  await borrarPorEmail(email)
  await borrarCorreos(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })

  const enlace = await enlaceDeAlta(email)
  const url = new URL(enlace)
  expect(url.origin).toBe(new URL(baseURL!).origin)
  expect(url.pathname).toBe('/auth/callback')
  expect(url.searchParams.get('type')).toBe('signup')
  expect(enlace).not.toContain('/auth/v1/verify')
  const correo = await ultimoCorreo(email)
  expect(correo?.subject).toBe('Confirmá tu correo — TechRepair Pro')
  expect(correo?.html).toContain('techrepairpro.soporte@gmail.com')

  // El escáner de correo pre-abre el enlace sin JS: no confirma nada.
  expect((await fetch(enlace)).status).toBe(200)
  const id = await idDe(email)
  expect(
    consultarJSON<{ ok: boolean }>(`SELECT email_confirmed_at IS NULL AS ok FROM auth.users WHERE id = '${id}'`).ok,
    'un GET sin JS no confirma la cuenta',
  ).toBe(true)

  // El usuario hace click: el enlace se abre en OTRA pestaña.
  const pestana = await context.newPage()
  await pestana.goto(enlace)
  await expect(pestana).toHaveURL(/\/no-business/, { timeout: 25_000 })
  await expect(pestana.getByTestId('no-business-create')).toBeVisible()
  expect(pestana.url()).not.toContain('token_hash')

  // La pestaña original (/verificar-email) avanza sola al ver la sesión.
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })

  // Confirmar no provisiona.
  expect(contarBusinesses(id!)).toBe(0)
  expect(
    consultarJSON<{ ok: boolean }>(`SELECT email_confirmed_at IS NOT NULL AS ok FROM auth.users WHERE id = '${id}'`).ok,
  ).toBe(true)

  await borrarPorEmail(email)
})

test('@m7 7. un enlace de alta YA USADO nunca cae en la pantalla de recovery', async ({ page, browser }) => {
  const email = emailUnico(`usado-${Date.now()}`)
  await borrarPorEmail(email)
  await borrarCorreos(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  const enlace = await enlaceDeAlta(email)

  await page.goto(enlace)
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })

  // Segundo click en el MISMO navegador (ya confirmado): sigue normal.
  await page.goto(enlace)
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })

  // En otro dispositivo, sin sesión: al login con motivo de ALTA, no a recovery.
  const otro = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const p2 = await otro.newPage()
  const urls: string[] = []
  p2.on('framenavigated', f => { if (f === p2.mainFrame()) urls.push(f.url()) })
  await p2.goto(enlace)
  await expect(p2).toHaveURL(/\/login\?motivo=link_invalido/, { timeout: 25_000 })
  await expect(p2.getByTestId('login-error')).toContainText('enlace de confirmación')
  expect(urls.some(u => u.includes('/reset-password')), urls.join(' | ')).toBe(false)
  await otro.close()

  await borrarPorEmail(email)
})

test('@m7 8. redirect degradado al Site URL: /?token_hash=…&type=signup igual confirma', async ({ page, baseURL }) => {
  const email = emailUnico(`raiz-${Date.now()}`)
  await borrarPorEmail(email)
  await borrarCorreos(email)

  await registrarse(page, email)
  await expect(page).toHaveURL(/\/verificar-email/, { timeout: 25_000 })
  const enlace = new URL(await enlaceDeAlta(email))

  // Lo que arma GoTrue cuando el redirect_to no está permitido: la RAÍZ del Site URL.
  const raiz = new URL(`/?token_hash=${enlace.searchParams.get('token_hash')}&type=signup`, baseURL!)
  await page.goto(raiz.toString())
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })
  expect(page.url()).not.toContain('token_hash')

  const id = await idDe(email)
  expect(
    consultarJSON<{ ok: boolean }>(`SELECT email_confirmed_at IS NOT NULL AS ok FROM auth.users WHERE id = '${id}'`).ok,
  ).toBe(true)

  await borrarPorEmail(email)
})

test('@m7 9. política y errores: 7 caracteres no se registran; un error_description arbitrario no se pinta', async ({ page }) => {
  const email = emailUnico(`politica-${Date.now()}`)
  await borrarPorEmail(email)

  await page.goto('/login?modo=registro')
  await expect(page.getByTestId('login-confirm-password')).toBeVisible({ timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', 'corta12')
  await page.fill('[data-testid="login-confirm-password"]', 'corta12')
  await page.click('[data-testid="login-submit"]')
  await expect(page.getByText('Usá al menos 8 caracteres.')).toBeVisible()
  expect(await idDe(email), 'no se creó el usuario').toBeNull()

  await page.goto('/login?error=x&error_description=TechRepair+fue+hackeado')
  await expect(page.getByTestId('login-error')).toContainText('No pudimos completar el inicio de sesión')
  await expect(page.locator('body')).not.toContainText(/hackeado/i)

  await page.goto('/auth/callback?error=x&error_description=TechRepair+fue+hackeado')
  await expect(page.locator('body')).toContainText('No pudimos completar el inicio de sesión')
  await expect(page.locator('body')).not.toContainText(/hackeado/i)
})
