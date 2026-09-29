// ============================================================================
// PRE-BETA-2F — Invitación por correo, de punta a punta, contra el stack LOCAL.
//
// Navegador real (bundle e2e) → /users → «Invitar Usuario» → Edge
// `send-business-invitation` REAL servido por scripts/e2e/invitation-edge-harness.ts
// (JWT del navegador, RPC canónica, RLS) → correo capturado por un Resend SIMULADO →
// el invitado abre el enlace DEL CORREO → acepta → queda en el negocio del owner.
//
// Nunca Resend real, nunca producción. Sin harness la suite se SALTEA con motivo.
//
// La invariante de P0-P2 se vuelve a medir con el correo en el medio:
//     accept_business_invitation() = suma un miembro a un business EXISTENTE
//                                  = NO crea businesses ni trials
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { consultarJSON } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'
import { createCompatibleUserClient } from '../setup/compatibleUserClient.ts'

test.use({ storageState: { cookies: [], origins: [] } })

const HARNESS = process.env.INVITATION_E2E_HARNESS_URL ?? 'http://127.0.0.1:5198'
const PASSWORD = 'e2e-invitacion-2f-pass-123'
const rand = () => Math.random().toString(36).slice(2, 8)
// Minúsculas: es la forma que guarda la DB (lower(btrim(email))) y la que recibe el correo.
const emailUnico = (sufijo: string) => `e2e-inv2f-${sufijo}-${rand()}@e2e.local`.toLowerCase()

interface Mensaje {
  idempotencyKey: string
  from: string
  to: string[]
  subject: string
  html: string
  text: string
  bodyKeys: string[]
}

let harnessOk = false
test.beforeAll(async () => {
  try { harnessOk = (await fetch(`${HARNESS}/__e2e/stats`)).ok } catch { harnessOk = false }
})
test.beforeEach(async () => {
  test.setTimeout(120_000)
  test.skip(!harnessOk, `Harness de invitaciones no disponible en ${HARNESS} (node scripts/e2e/invitation-edge-harness-run.mjs)`)
  await control('reset')
})

// ─── Harness ────────────────────────────────────────────────────────────────
async function control<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HARNESS}/__e2e/${path}`, body === undefined && (path === 'stats' || path === 'outbox')
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return await res.json() as T
}
const bandeja = async () => (await control<{ messages: Mensaje[] }>('outbox')).messages
const stats = () => control<{ attempts: number; delivered: number }>('stats')

/** El Edge real vive en el harness: el navegador sigue llamando a /functions/v1/send-business-invitation. */
async function routeEdge(page: Page) {
  await page.route(/\/functions\/v1\/send-business-invitation$/, async (route) => {
    const response = await route.fetch({ url: `${HARNESS}/functions/v1/send-business-invitation` })
    await route.fulfill({ response })
  })
}

// ─── Siembra ────────────────────────────────────────────────────────────────
async function admin() {
  const d = await assertDestinoLocalSeguro()
  return createClient(d.supabaseUrl, d.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function crearUsuarioConfirmado(email: string): Promise<string> {
  const sb = await admin()
  const { data, error } = await sb.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`No se pudo crear ${email}: ${error.message}`)
  return data.user!.id
}

/** Owner + negocio por la autoridad canónica. No se inserta a mano. */
async function crearOwnerConNegocio(email: string, nombre: string): Promise<{ id: string; businessId: string }> {
  const id = await crearUsuarioConfirmado(email)
  const d = await assertDestinoLocalSeguro()
  const sb = createCompatibleUserClient(d)
  const { error: errLogin } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (errLogin) throw new Error(`login de ${email}: ${errLogin.message}`)
  const { data, error } = await sb.rpc('provision_my_business', { p_business_name: nombre })
  await sb.auth.signOut()
  if (error) throw new Error(`provision de ${email}: ${error.message}`)
  return { id, businessId: (data as { business_id: string }).business_id }
}

const contarBusinesses = () => consultarJSON<{ n: number }>('SELECT count(*)::int AS n FROM public.businesses').n
const contarTrials = () =>
  consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.businesses WHERE subscription_status = 'trialing'`).n

const pendientesDe = (businessId: string) => consultarJSON<{ n: number; id: string | null; token: string | null; email: string | null }>(
  `SELECT count(*)::int AS n, max(id::text) AS id, max(token) AS token, max(email) AS email
     FROM public.business_invitations WHERE business_id = '${businessId}' AND status = 'pending'`,
)

const perfilDe = (id: string) => consultarJSON<{ n: number; business_id: string | null; role: string | null }>(
  `SELECT count(*)::int AS n, max(business_id::text) AS business_id, max(role) AS role
     FROM public.profiles WHERE id = '${id}' OR user_id = '${id}'`,
)

const estadoInvitacion = (id: string) =>
  consultarJSON<{ status: string | null }>(`SELECT max(status) AS status FROM public.business_invitations WHERE id = '${id}'`).status

test.afterEach(async () => {
  const { ids } = consultarJSON<{ ids: string[] }>(
    `SELECT coalesce(json_agg(id::text), '[]'::json) AS ids FROM auth.users WHERE email LIKE 'e2e-inv2f-%@e2e.local'`,
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
  await page.waitForURL(/\/(dashboard|no-business|onboarding|first-steps)/, { timeout: 25_000 })
}

async function invitarPorUI(page: Page, email: string) {
  await page.goto('/users')
  await page.getByTestId('invite-open').click()
  await page.getByTestId('invite-email').fill(email)
  await page.getByTestId('invite-submit').click()
}

const hrefDe = (html: string) => (html.match(/href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&')

// ────────────────────────────────────────────────────────────────────────────

test('@m7 PRE-BETA-2F 1. «Invitar» manda el correo y su enlace suma al invitado al negocio, sin crear tenants', async ({ page, browser, baseURL }) => {
  const emailA = emailUnico('ownerA')
  const emailB = emailUnico('invitadaB')
  const A = await crearOwnerConNegocio(emailA, 'Taller 2F Uno')
  const idB = await crearUsuarioConfirmado(emailB)

  await loguearsePorUI(page, emailA)
  await routeEdge(page)
  // Mayúsculas a propósito: el destinatario del correo tiene que ser el que normalizó la DB.
  await invitarPorUI(page, emailB.toUpperCase())
  await expect(page.getByText(`Invitación enviada a ${emailB}.`)).toBeVisible({ timeout: 25_000 })

  const inv = pendientesDe(A.businessId)
  expect(inv.n, 'una sola invitación pending').toBe(1)
  expect(inv.email).toBe(emailB)

  const correos = await bandeja()
  expect(correos, 'exactamente un correo').toHaveLength(1)
  const correo = correos[0]
  expect(correo.to).toEqual([emailB])
  expect(correo.from).toBe('TechRepair Pro <no-reply@techrepairpro.app>')
  expect(correo.subject).toBe('Te invitaron a Taller 2F Uno — TechRepair Pro')
  expect(correo.bodyKeys).toEqual(['from', 'html', 'subject', 'text', 'to'])
  expect(correo.idempotencyKey).toBe(`invite-create-${inv.id}`)
  expect(correo.html).not.toMatch(/<img|CONTACTO_SOPORTE|soporte@/i)
  const enlace = hrefDe(correo.html)
  expect(enlace).toBe(`${baseURL}/accept-invite?token=${inv.token}`)
  expect(correo.html.split(inv.token!).length - 1, 'el token sólo en el href').toBe(1)

  // La lista de pendientes muestra el MISMO enlace (misma fuente).
  await expect(page.getByTestId('invitation-link')).toHaveText(enlace)

  const bizAntes = contarBusinesses()
  const trialsAntes = contarTrials()

  // El invitado abre el enlace DEL CORREO en su propio navegador.
  const ctxB = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const pageB = await ctxB.newPage()
  await loguearsePorUI(pageB, emailB)
  await pageB.goto(enlace)
  await expect(pageB.getByText(/Invitación aceptada|Ya sos parte del equipo/i)).toBeVisible({ timeout: 25_000 })
  await pageB.waitForURL(/\/dashboard/, { timeout: 25_000 })
  await ctxB.close()

  const perfil = perfilDe(idB)
  expect(perfil.n).toBe(1)
  expect(perfil.business_id, 'B queda en el negocio de A').toBe(A.businessId)
  expect(perfil.role).toBe('tech')
  expect(contarBusinesses(), 'no se crea ningún business').toBe(bizAntes)
  expect(contarTrials(), 'no se inicia ningún trial').toBe(trialsAntes)
  expect(estadoInvitacion(inv.id!)).toBe('accepted')
})

test('@m7 PRE-BETA-2F 2. si el proveedor falla la invitación queda, y «Reenviar correo» manda el MISMO token', async ({ page }) => {
  const emailA = emailUnico('ownerA')
  const emailB = emailUnico('invitadaB')
  const A = await crearOwnerConNegocio(emailA, 'Taller 2F Dos')

  await control('mode', { provider: 'fail' })
  await loguearsePorUI(page, emailA)
  await routeEdge(page)
  await invitarPorUI(page, emailB)
  await expect(page.getByText('La invitación quedó creada, pero no pudimos enviar el correo. Podés reenviarlo o copiar el link.'))
    .toBeVisible({ timeout: 25_000 })

  const inv = pendientesDe(A.businessId)
  expect(inv.n, 'la invitación quedó creada').toBe(1)
  expect((await stats()).attempts).toBeGreaterThanOrEqual(1)
  expect(await bandeja(), 'ningún correo salió').toHaveLength(0)
  await expect(page.getByTestId('pending-invitation-row')).toHaveCount(1)

  // El proveedor vuelve: reenviar manda la MISMA invitación, no crea otra.
  await control('mode', { provider: 'ok' })
  await page.getByTestId('invitation-resend').click()
  await expect(page.getByText('Invitación reenviada.')).toBeVisible({ timeout: 25_000 })

  const correos = await bandeja()
  expect(correos).toHaveLength(1)
  expect(correos[0].to).toEqual([emailB])
  expect(correos[0].idempotencyKey.startsWith(`invite-resend-${inv.id}-`)).toBe(true)
  expect(hrefDe(correos[0].html).endsWith(`/accept-invite?token=${inv.token}`)).toBe(true)
  const despues = pendientesDe(A.businessId)
  expect(despues.n, 'reenviar no crea otra invitación').toBe(1)
  expect(despues.token, 'mismo token').toBe(inv.token)
})
