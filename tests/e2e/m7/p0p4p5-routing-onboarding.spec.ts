// ============================================================================
// P0-P4 + P0-P5 — Routing/recovery y onboarding, end-to-end contra el stack
// LOCAL.
//
// Contraparte de tests/sql/p0p5_business_onboarding.test.sql (contrato del
// servidor) y tests/components/routingRecoveryOnboarding.test.tsx (cliente).
// Acá se recorre el camino real con navegador y varios actores.
//
// Invariantes que se miden:
//   · el onboarding CONFIGURA; NUNCA crea un business
//   · un owner existente recupera su negocio sin provisionar de nuevo
//   · un invitado NO pasa por el onboarding de owner
//   · el refresh conserva lo ya guardado
//   · cross-tenant imposible: la RPC no acepta business_id
//
// NUNCA corre contra producción: el globalSetup valida el destino y
// `assertDestinoLocalSeguro` lo revalida acá.
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'

test.use({ storageState: { cookies: [], origins: [] } })

const PASSWORD = 'e2e-onboarding-pass-123'
// Siempre en minúsculas: GoTrue normaliza el correo al guardarlo, así que un
// sufijo con mayúsculas se crea como `...ownerb4@...` y después no se encuentra.
const emailUnico = (sufijo: string) => `e2e-onb-${sufijo.toLowerCase()}@e2e.local`

async function admin() {
  const d = await assertDestinoLocalSeguro()
  return createClient(d.supabaseUrl, d.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** SQL directo, no `listUsers()`: pagina de a 50 y da falsos negativos. */
function idDe(email: string): string | null {
  return consultarJSON<{ id: string | null }>(
    `SELECT max(id::text) AS id FROM auth.users WHERE lower(email) = lower('${email}')`,
  ).id
}

async function crearUsuarioConfirmado(email: string): Promise<string> {
  const existente = idDe(email)
  if (existente) {
    const sb = await admin()
    await sb.auth.admin.deleteUser(existente).catch(() => {})
  }
  const sb = await admin()
  const { data, error } = await sb.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  })
  if (error) throw new Error(`No se pudo crear ${email}: ${error.message}`)
  return data.user!.id
}

const contarBusinesses = () =>
  consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.businesses`).n

const contarTrials = () =>
  consultarJSON<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.businesses WHERE subscription_status = 'trialing'`,
  ).n

const negocioDe = (uid: string) =>
  consultarJSON<{
    n: number; business_id: string | null; name: string | null; rubro: string | null;
    ciudad: string | null; whatsapp: string | null; completed: boolean | null; role: string | null;
  }>(`
    SELECT count(*)::int                    AS n,
           max(b.id::text)                  AS business_id,
           max(b.name)                      AS name,
           max(b.rubro)                     AS rubro,
           max(b.ciudad)                    AS ciudad,
           max(b.wholesale_whatsapp)        AS whatsapp,
           bool_or(coalesce(b.onboarding_completed,false)) AS completed,
           max(p.role)                      AS role
      FROM public.profiles p
      JOIN public.businesses b ON b.id = p.business_id
     WHERE coalesce(p.user_id, p.id) = '${uid}'`)

const settingsDe = (bizId: string) =>
  consultarJSON<{ n: number; cuit: string | null; cond: string | null }>(`
    SELECT count(*)::int AS n, max(cuit) AS cuit, max(condicion_iva) AS cond
      FROM public.business_settings WHERE business_id = '${bizId}'`)

async function loguearse(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
  // Esperar a ATERRIZAR: el click sólo garantiza el click, no la sesión.
  await page.waitForURL(/\/(dashboard|no-business|onboarding)/, { timeout: 25_000 })
}

/** Limpieza incondicional: un test que falla no puede envenenar el siguiente. */
test.afterEach(async () => {
  const { ids } = consultarJSON<{ ids: string[] }>(
    `SELECT coalesce(json_agg(id::text), '[]'::json) AS ids
       FROM auth.users WHERE email LIKE 'e2e-onb-%@e2e.local'`,
  )
  if (!ids.length) return
  const sb = await admin()
  for (const id of ids) await sb.auth.admin.deleteUser(id).catch(() => {})
})

// ────────────────────────────────────────────────────────────────────────────

test('@m7 1. owner nuevo: recovery -> onboarding -> dashboard, 1 solo business', async ({ page }) => {
  const email = emailUnico('owner1')
  const uid = await crearUsuarioConfirmado(email)

  const bizAntes = contarBusinesses()
  const trialsAntes = contarTrials()

  // Sin negocio, el guard lo lleva al recovery. La pantalla NO crea nada sola.
  await loguearse(page, email)
  await expect(page).toHaveURL(/\/no-business/, { timeout: 25_000 })
  await expect(page.getByTestId('no-business-create')).toBeVisible()
  expect(contarBusinesses(), 'montar el recovery no crea negocios').toBe(bizAntes)

  // Alta EXPLÍCITA.
  await page.fill('[data-testid="no-business-name"]', 'Taller E2E Uno');
  await page.click('[data-testid="no-business-crear"]');
  await page.waitForURL(/\/onboarding/, { timeout: 25_000 })

  expect(contarBusinesses(), 'el alta crea exactamente 1 business').toBe(bizAntes + 1)
  expect(contarTrials(), 'y su trial').toBe(trialsAntes + 1)

  // ── Onboarding: cada paso PERSISTE ───────────────────────────────────────
  await page.waitForSelector('[data-testid="onboarding-business-name"]', { timeout: 25_000 })
  await page.fill('[data-testid="onboarding-business-name"]', 'Taller E2E Uno')
  await page.click('[data-testid="onboarding-rubro-celulares"]')
  await page.click('[data-testid="onboarding-step1-submit"]')

  // Logo: se omite (tiene su propio caso). Contacto:
  await page.waitForSelector('[data-testid="onboarding-logo-skip"]', { timeout: 25_000 })
  await page.click('[data-testid="onboarding-logo-skip"]')

  await page.waitForSelector('[data-testid="onboarding-whatsapp"]', { timeout: 25_000 })
  await page.fill('[data-testid="onboarding-whatsapp"]', '351 234-5678')
  await page.fill('[data-testid="onboarding-ciudad"]', 'Córdoba')
  await page.click('[data-testid="onboarding-step3-submit"]')

  await page.waitForSelector('[data-testid="onboarding-cuit"]', { timeout: 25_000 })
  await page.click('[data-testid="onboarding-cond-monotributo"]')
  await page.fill('[data-testid="onboarding-cuit"]', '20123456789')
  await page.click('[data-testid="onboarding-step4-submit"]')

  await page.waitForSelector('[data-testid="onboarding-step5-submit"]', { timeout: 25_000 })
  await page.click('[data-testid="onboarding-step5-submit"]')

  await page.waitForSelector('[data-testid="onboarding-finish"]', { timeout: 25_000 })
  await page.click('[data-testid="onboarding-finish"]')
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  // ── ASSERT contra la DB: todo lo prometido quedó guardado ────────────────
  const neg = negocioDe(uid)
  expect(neg.n, 'exactamente 1 negocio').toBe(1)
  expect(neg.name).toBe('Taller E2E Uno')
  expect(neg.rubro).toBe('celulares')
  expect(neg.ciudad).toBe('Córdoba')
  expect(neg.whatsapp, 'el whatsapp se normaliza a dígitos').toBe('3512345678')
  expect(neg.completed, 'onboarding_completed persistido').toBe(true)
  expect(neg.role).toBe('owner')

  const st = settingsDe(neg.business_id!)
  expect(st.n, 'la fila de business_settings se creó por upsert').toBe(1)
  expect(st.cuit).toBe('20123456789')
  expect(st.cond).toBe('monotributo')

  // LA INVARIANTE: configurar no creó negocios de más.
  expect(contarBusinesses()).toBe(bizAntes + 1)

  // ── Logout/login: recupera el mismo negocio, sin provisionar ─────────────
  await page.context().clearCookies()
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear() })

  await loguearse(page, email)
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 25_000 })

  const neg2 = negocioDe(uid)
  expect(neg2.business_id).toBe(neg.business_id)
  expect(contarBusinesses(), 'el re-login no crea tenants').toBe(bizAntes + 1)
})

test('@m7 2. refresh en medio del onboarding conserva lo guardado', async ({ page }) => {
  const email = emailUnico('refresh2')
  const uid = await crearUsuarioConfirmado(email)

  await loguearse(page, email)
  await page.fill('[data-testid="no-business-name"]', 'Taller E2E Dos')
  await page.click('[data-testid="no-business-crear"]')
  await page.waitForURL(/\/onboarding/, { timeout: 25_000 })

  await page.waitForSelector('[data-testid="onboarding-business-name"]', { timeout: 25_000 })
  await page.fill('[data-testid="onboarding-business-name"]', 'Taller E2E Dos')
  await page.click('[data-testid="onboarding-rubro-redes"]')
  await page.click('[data-testid="onboarding-step1-submit"]')
  await page.waitForSelector('[data-testid="onboarding-logo-skip"]', { timeout: 25_000 })

  const bizAntes = contarBusinesses()

  // REFRESH duro: el estado de React se pierde por completo.
  await page.reload()

  // La precarga sale de la DB, así que el paso 1 ya no vuelve a pedirse.
  await page.waitForSelector('[data-testid="onboarding-logo-skip"]', { timeout: 25_000 })
  await expect(page.getByTestId('onboarding-business-name')).toHaveCount(0)

  const neg = negocioDe(uid)
  expect(neg.name, 'el nombre sobrevivió al refresh').toBe('Taller E2E Dos')
  expect(neg.rubro, 'el rubro sobrevivió al refresh').toBe('redes')
  expect(contarBusinesses(), 'refrescar no duplica el tenant').toBe(bizAntes)
})

test('@m7 3. un invitado NO pasa por el onboarding de owner', async ({ page }) => {
  const emailOwner = emailUnico('owner3')
  const emailTech = emailUnico('tech3')

  const ownerUid = await crearUsuarioConfirmado(emailOwner)
  await crearUsuarioConfirmado(emailTech)

  // Owner con negocio, por la autoridad canónica.
  const d = await assertDestinoLocalSeguro()
  const sb = createClient(d.supabaseUrl, d.anonKey)
  await sb.auth.signInWithPassword({ email: emailOwner, password: PASSWORD })
  await sb.rpc('provision_my_business', { p_business_name: 'Taller E2E Tres' })
  const token = ((await sb.rpc('create_business_invitation', {
    p_email: emailTech, p_role: 'tech',
  })).data as { token: string }).token
  await sb.auth.signOut()

  const bizOwner = negocioDe(ownerUid).business_id
  const bizAntes = contarBusinesses()

  // El invitado acepta y entra.
  const techUid = idDe(emailTech)!
  await loguearse(page, emailTech)
  await page.goto(`/accept-invite?token=${token}`)
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  // Su negocio tiene onboarding_completed = false, pero eso pertenece a la
  // CONFIGURACIÓN del negocio y no al lifecycle de cada miembro: el tech no
  // puede quedar atrapado en el wizard de owner.
  const neg = negocioDe(techUid)
  expect(neg.business_id).toBe(bizOwner)
  expect(neg.role).toBe('tech')
  expect(neg.completed).toBe(false)
  await expect(page).toHaveURL(/\/dashboard/)

  // Y si escribe /onboarding a mano, se le explica en vez de romper.
  await page.goto('/onboarding')
  await expect(page.getByTestId('onboarding-ir-dashboard')).toBeVisible({ timeout: 25_000 })

  expect(contarBusinesses(), 'nada de esto crea negocios').toBe(bizAntes)
})

test('@m7 4. cross-tenant: la RPC no acepta business_id', async () => {
  const emailA = emailUnico('ownerA4')
  const emailB = emailUnico('ownerB4')
  await crearUsuarioConfirmado(emailA)
  await crearUsuarioConfirmado(emailB)

  const d = await assertDestinoLocalSeguro()

  const sbA = createClient(d.supabaseUrl, d.anonKey)
  await sbA.auth.signInWithPassword({ email: emailA, password: PASSWORD })
  await sbA.rpc('provision_my_business', { p_business_name: 'Taller A4' })

  const sbB = createClient(d.supabaseUrl, d.anonKey)
  await sbB.auth.signInWithPassword({ email: emailB, password: PASSWORD })
  await sbB.rpc('provision_my_business', { p_business_name: 'Taller B4' })
  const bizB = negocioDe(idDe(emailB)!).business_id!

  // A intenta configurar el negocio de B mandando su id. PostgREST rechaza el
  // parámetro porque la firma no lo tiene: el tenant no es un dato del cliente.
  const { error } = await sbA.rpc('update_my_business_onboarding', {
    p_business_id: bizB, p_name: 'Secuestrado',
  } as Record<string, unknown>)
  expect(error, 'mandar business_id tiene que fallar').not.toBeNull()

  // Y sin el parámetro, A sólo puede tocar el suyo.
  await sbA.rpc('update_my_business_onboarding', { p_name: 'Taller A4 renombrado' })

  expect(consultarJSON<{ name: string }>(
    `SELECT max(name) AS name FROM public.businesses WHERE id='${bizB}'`).name,
  ).toBe('Taller B4')

  await sbA.auth.signOut()
  await sbB.auth.signOut()
})

test('@m7 5. recovery: un fallo de red NO ofrece crear un tenant', async ({ page }) => {
  const email = emailUnico('recovery5')
  await crearUsuarioConfirmado(email)

  await loguearse(page, email)
  await expect(page.getByTestId('no-business-create')).toBeVisible({ timeout: 25_000 })

  const bizAntes = contarBusinesses()

  // Se corta `get_my_profile`: ahora NO sabemos si el usuario tiene negocio.
  await page.route('**/rest/v1/rpc/get_my_profile', route => route.abort('failed'))
  await page.reload()

  // El estado correcto es AUTH_ERROR -> reintentar. Ofrecer «creá tu negocio»
  // acá es como se fabrican tenants duplicados a partir de un corte de red.
  await expect(page.getByTestId('no-business-error')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('no-business-crear')).toHaveCount(0)
  expect(contarBusinesses()).toBe(bizAntes)
})
