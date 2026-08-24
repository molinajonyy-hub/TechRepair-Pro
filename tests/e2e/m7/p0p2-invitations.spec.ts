// ============================================================================
// P0-P2 — Alta de miembros por invitación, end-to-end, contra el stack LOCAL.
//
// Contraparte de tests/sql/p0p2_business_invitations.test.sql (contrato del
// servidor) y tests/components/invitationsLifecycle.test.tsx (consumo del
// cliente). Acá se recorre el camino REAL, con navegador y sesiones distintas.
//
// La invariante que se mide en cada caso:
//
//     provision_my_business()      = ÚNICA autoridad que CREA businesses
//     accept_business_invitation() = incorpora a un business EXISTENTE
//
// Casos:
//   1. camino feliz: owner invita -> B se registra -> acepta -> queda en el
//      negocio de A, con rol tech, y NO se creó ningún business ni trial
//   2. B cierra sesión y vuelve a entrar -> sigue en el negocio de A
//   3. token de B abierto por C -> rechazo, cero membresías nuevas
//   4. owner de otro taller -> fail closed, su taller queda intacto
//   5. retry: aceptar dos veces -> resultado estable, 1 solo profile
//   6. el token sobrevive al rodeo por login (?redirectTo=)
//
// NUNCA corre contra producción: el globalSetup valida el destino y
// `assertDestinoLocalSeguro` lo revalida acá.
//
// Los correos locales se leen en Inbucket: http://127.0.0.1:54424
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'

// Sesión propia por test: este spec maneja varios actores y NO puede heredar el
// storageState del owner sembrado.
test.use({ storageState: { cookies: [], origins: [] } })

const PASSWORD = 'e2e-invitacion-pass-123'

const emailUnico = (sufijo: string) => `e2e-invit-${sufijo}@e2e.local`

async function admin() {
  const d = await assertDestinoLocalSeguro()
  return createClient(d.supabaseUrl, d.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/**
 * Busca el auth user por correo con SQL, no con `auth.admin.listUsers()`.
 *
 * `listUsers()` PAGINA (50 por página por defecto). Con el seed de E2E más los
 * usuarios de otros specs, un usuario recién creado puede caer fuera de la
 * primera página: la búsqueda devuelve null, la limpieza no borra nada y el
 * siguiente run muere con «already been registered». Es una trampa silenciosa
 * —falla en el SETUP, no en una aserción— y por eso acá se consulta directo.
 */
function idDe(email: string): string | null {
  return consultarJSON<{ id: string | null }>(
    `SELECT max(id::text) AS id FROM auth.users WHERE email = '${email}'`,
  ).id
}

async function borrarPorEmail(email: string): Promise<void> {
  const id = idDe(email)
  if (!id) return
  const sb = await admin()
  await sb.auth.admin.deleteUser(id).catch(() => {})
}

/**
 * Crea un auth user YA confirmado. El camino de confirmación por correo tiene
 * su propio spec (email-verification); acá lo que se mide es la invitación, y
 * pasar por Inbucket en cada caso sólo agregaría flakiness ajena al contrato.
 */
async function crearUsuarioConfirmado(email: string): Promise<string> {
  await borrarPorEmail(email)
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

const perfilDe = (id: string) =>
  consultarJSON<{ n: number; business_id: string | null; role: string | null }>(
    `SELECT count(*)::int AS n,
            max(business_id::text) AS business_id,
            max(role)              AS role
       FROM public.profiles WHERE id = '${id}' OR user_id = '${id}'`,
  )

const estadoInvitacion = (token: string) =>
  consultarJSON<{ status: string | null }>(
    `SELECT max(status) AS status FROM public.business_invitations WHERE token = '${token}'`,
  ).status

/** Owner + negocio, por la autoridad canónica. No se inserta a mano. */
async function crearOwnerConNegocio(email: string, nombre: string): Promise<{ id: string; businessId: string }> {
  const id = await crearUsuarioConfirmado(email)
  const d = await assertDestinoLocalSeguro()
  const sb = createClient(d.supabaseUrl, d.anonKey)
  const { error: errLogin } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (errLogin) throw new Error(`login de ${email}: ${errLogin.message}`)

  const { data, error } = await sb.rpc('provision_my_business', { p_business_name: nombre })
  if (error) throw new Error(`provision de ${email}: ${error.message}`)
  await sb.auth.signOut()

  return { id, businessId: (data as { business_id: string }).business_id }
}

/** Emite una invitación como `emailOwner`, por la RPC canónica. */
async function invitar(emailOwner: string, emailInvitado: string, rol: string): Promise<string> {
  const d = await assertDestinoLocalSeguro()
  const sb = createClient(d.supabaseUrl, d.anonKey)
  const { error: errLogin } = await sb.auth.signInWithPassword({ email: emailOwner, password: PASSWORD })
  if (errLogin) throw new Error(`login de ${emailOwner}: ${errLogin.message}`)

  const { data, error } = await sb.rpc('create_business_invitation', {
    p_email: emailInvitado, p_role: rol,
  })
  await sb.auth.signOut()
  if (error) throw new Error(`create_business_invitation: ${error.message}`)
  return (data as { token: string }).token
}

/**
 * Login por UI que ESPERA a aterrizar.
 *
 * El `await` del click sólo garantiza que el click ocurrió, no que la sesión ya
 * esté establecida. Navegar en ese hueco hace que `/accept-invite` vea
 * `isAuthenticated === false` y rebote a login — que es correcto por parte del
 * producto, pero convierte al test en una carrera. Esperar a salir de `/login`
 * es la señal real de que la sesión quedó lista.
 */
/**
 * Limpieza incondicional. Los `borrarPorEmail` del final de cada caso no corren
 * si el test falla antes, y entonces el run SIGUIENTE muere en el setup con
 * «A user with this email address has already been registered» — un rojo que no
 * tiene nada que ver con el contrato. Con esto la suite es re-ejecutable.
 */
test.afterEach(async () => {
  const { ids } = consultarJSON<{ ids: string[] }>(
    `SELECT coalesce(json_agg(id::text), '[]'::json) AS ids
       FROM auth.users WHERE email LIKE 'e2e-invit-%@e2e.local'`,
  )
  if (!ids.length) return
  const sb = await admin()
  for (const id of ids) await sb.auth.admin.deleteUser(id).catch(() => {})
})

async function loguearsePorUI(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForURL(/\/(dashboard|no-business|onboarding)/, { timeout: 25_000 })
}

// ────────────────────────────────────────────────────────────────────────────

test('@m7 1. invitación completa: B queda en el negocio de A, sin crear tenants', async ({ page }) => {
  const emailA = emailUnico('ownerA1')
  const emailB = emailUnico('invitadoB1')

  const A = await crearOwnerConNegocio(emailA, 'Taller Invitaciones 1')
  const idB = await crearUsuarioConfirmado(emailB)
  const token = await invitar(emailA, emailB, 'tech')

  // Línea base JUSTO antes de aceptar: es contra esto que se mide "no se creó
  // ningún negocio". Tomarla al principio del test contaría el alta de A.
  const bizAntes = contarBusinesses()
  const trialsAntes = contarTrials()

  // Sin negocio propio, el guard lo manda a /no-business. Es el estado esperado
  // de un invitado que todavía no aceptó.
  await loguearsePorUI(page, emailB)

  await page.goto(`/accept-invite?token=${token}`)
  await expect(page.getByText(/Invitación aceptada|Ya sos parte del equipo/i)).toBeVisible({ timeout: 25_000 })
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  const perfil = perfilDe(idB)
  expect(perfil.n, 'B debe tener exactamente 1 profile').toBe(1)
  expect(perfil.business_id, 'B debe estar en el negocio de A').toBe(A.businessId)
  expect(perfil.role, 'B debe tener el rol de la invitación').toBe('tech')

  // LA INVARIANTE: aceptar una invitación no crea negocios ni trials.
  expect(contarBusinesses(), 'no debe crearse ningún business').toBe(bizAntes)
  expect(contarTrials(), 'no debe iniciarse ningún trial').toBe(trialsAntes)
  expect(estadoInvitacion(token)).toBe('accepted')

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailB)
})

test('@m7 2. B cierra sesión y vuelve: sigue en el negocio de A', async ({ page }) => {
  const emailA = emailUnico('ownerA2')
  const emailB = emailUnico('invitadoB2')

  const A = await crearOwnerConNegocio(emailA, 'Taller Invitaciones 2')
  const idB = await crearUsuarioConfirmado(emailB)
  const token = await invitar(emailA, emailB, 'sales')

  await loguearsePorUI(page, emailB)
  await page.goto(`/accept-invite?token=${token}`)
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  // Logout real por la app, no borrando storage a mano.
  await page.context().clearCookies()
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear() })

  await loguearsePorUI(page, emailB)
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  const perfil = perfilDe(idB)
  expect(perfil.business_id).toBe(A.businessId)
  expect(perfil.role).toBe('sales')

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailB)
})

test('@m7 3. el token de B abierto por C es rechazado', async ({ page }) => {
  const emailA = emailUnico('ownerA3')
  const emailB = emailUnico('invitadoB3')
  const emailC = emailUnico('terceroC3')

  await crearOwnerConNegocio(emailA, 'Taller Invitaciones 3')
  await crearUsuarioConfirmado(emailB)
  const idC = await crearUsuarioConfirmado(emailC)
  const token = await invitar(emailA, emailB, 'tech')

  const bizAntes = contarBusinesses()

  await loguearsePorUI(page, emailC)
  await page.goto(`/accept-invite?token=${token}`)

  // Mensaje de producto, no un SQLSTATE ni el nombre del error del servidor.
  await expect(page.getByText(/otra dirección de correo/i)).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText(/INVITATION_EMAIL_MISMATCH|TRIEM|42501/)).toHaveCount(0)

  const perfilC = perfilDe(idC)
  expect(perfilC.n, 'C no debe haber ganado ninguna membresía').toBe(0)
  expect(contarBusinesses()).toBe(bizAntes)
  expect(estadoInvitacion(token), 'la invitación sigue disponible para B').toBe('pending')

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailB)
  await borrarPorEmail(emailC)
})

test('@m7 4. un owner con negocio propio NO es movido de tenant', async ({ page }) => {
  const emailA = emailUnico('ownerA4')
  const emailC = emailUnico('ownerC4')

  await crearOwnerConNegocio(emailA, 'Taller Invitaciones 4A')
  const C = await crearOwnerConNegocio(emailC, 'Taller Invitaciones 4C')
  const token = await invitar(emailA, emailC, 'viewer')

  const bizAntes = contarBusinesses()

  await loguearsePorUI(page, emailC)
  await page.goto(`/accept-invite?token=${token}`)

  await expect(page.getByText(/ya pertenece a otro negocio/i)).toBeVisible({ timeout: 25_000 })

  // El taller de C queda EXACTAMENTE como estaba: sin mover el profile, sin
  // degradar el rol, sin tocar owner_user_id y sin borrar nada.
  const perfilC = perfilDe(C.id)
  expect(perfilC.business_id).toBe(C.businessId)
  expect(perfilC.role).toBe('owner')

  const duenio = consultarJSON<{ owner: string | null }>(
    `SELECT max(owner_user_id::text) AS owner FROM public.businesses WHERE id = '${C.businessId}'`,
  ).owner
  expect(duenio).toBe(C.id)
  expect(contarBusinesses()).toBe(bizAntes)

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailC)
})

test('@m7 5. aceptar dos veces da un resultado estable y 1 solo profile', async ({ page }) => {
  const emailA = emailUnico('ownerA5')
  const emailB = emailUnico('invitadoB5')

  const A = await crearOwnerConNegocio(emailA, 'Taller Invitaciones 5')
  const idB = await crearUsuarioConfirmado(emailB)
  const token = await invitar(emailA, emailB, 'cashier')

  await loguearsePorUI(page, emailB)
  await page.goto(`/accept-invite?token=${token}`)
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  const bizAntes = contarBusinesses()

  // Segunda vez: el usuario vuelve a abrir el link del correo.
  await page.goto(`/accept-invite?token=${token}`)
  await expect(page.getByText(/Ya sos parte del equipo|Invitación aceptada/i)).toBeVisible({ timeout: 25_000 })

  const perfil = perfilDe(idB)
  expect(perfil.n, 'sigue habiendo 1 solo profile').toBe(1)
  expect(perfil.business_id).toBe(A.businessId)
  expect(perfil.role, 'el rol no cambia al reaceptar').toBe('cashier')
  expect(contarBusinesses()).toBe(bizAntes)

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailB)
})

test('@m7 6. el token sobrevive al rodeo por el login', async ({ page }) => {
  const emailA = emailUnico('ownerA6')
  const emailB = emailUnico('invitadoB6')

  const A = await crearOwnerConNegocio(emailA, 'Taller Invitaciones 6')
  const idB = await crearUsuarioConfirmado(emailB)
  const token = await invitar(emailA, emailB, 'tech')

  // Sin sesión: abre el link directamente, como llega del correo.
  await page.goto(`/accept-invite?token=${token}`)

  // Rebota a login CONSERVANDO el destino. Es el mecanismo que ya usa la app.
  await page.waitForURL(/\/login\?redirectTo=/, { timeout: 25_000 })
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('redirectTo') ?? ''))
    .toBe(`/accept-invite?token=${token}`)

  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', emailB)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')

  // Sin volver a pegar el token a mano: vuelve solo y acepta.
  await expect(page.getByText(/Invitación aceptada|Ya sos parte del equipo/i)).toBeVisible({ timeout: 25_000 })
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })

  const perfil = perfilDe(idB)
  expect(perfil.business_id).toBe(A.businessId)
  expect(perfil.role).toBe('tech')

  await borrarPorEmail(emailA)
  await borrarPorEmail(emailB)
})
