// ============================================================================
// ARCA Self-Service Phase 2B — asistente de configuración inicial, de punta a punta.
//
// Navegador real (bundle e2e) → Settings → ARCA → Edge `arca-selfservice-setup` REAL servido por
// scripts/e2e/arca-setup-edge-harness.ts contra el Supabase LOCAL (autoridad, plan, RPC y Vault
// reales). Sólo WSAA es simulado. Nunca ARCA, nunca producción, nunca Clic: cada test siembra
// su propio negocio con un CUIT y un nombre de equipo únicos.
//
// Requiere el harness corriendo (node scripts/e2e/arca-setup-edge-harness-run.mjs). Sin él, la
// suite se SALTEA con un motivo explícito en vez de dar un verde falso.
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal.ts'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'
import { createCompatibleUserClient } from '../setup/compatibleUserClient.ts'

test.use({ storageState: { cookies: [], origins: [] } })

const HARNESS = process.env.ARCA_E2E_HARNESS_URL ?? 'http://127.0.0.1:5199'
const PASSWORD = 'e2e-arca-2b-pass-123'
const SHOTS = process.env.ARCA_E2E_SCREENSHOTS ?? join('test-results', 'arca-phase2b-screens')
const LEAK = /PRIVATE KEY|LOCAL-E2E-TOKEN|LOCAL-E2E-SIGN|signing_key|secret_id|verification_attempt_id|\b[0-9a-f]{64}\b/i

let harnessOk = false
test.beforeAll(async () => {
  try { harnessOk = (await fetch(`${HARNESS}/__e2e/stats`)).ok } catch { harnessOk = false }
})
test.beforeEach(async () => {
  // Clave RSA real + firma PKCS#7 + varias recargas: más que el timeout por defecto de 30 s.
  test.setTimeout(180_000)
  test.skip(!harnessOk, `Harness del Edge no disponible en ${HARNESS} (node scripts/e2e/arca-setup-edge-harness-run.mjs)`)
  await control('reset')
})

// ─── Harness ────────────────────────────────────────────────────────────────
async function control<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HARNESS}/__e2e/${path}`, body === undefined && path === 'stats'
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  return await res.json() as T
}
const stats = () => control<{ loginCms: number; actions: Record<string, number> }>('stats')

/** El Edge real vive en el harness: el navegador sigue llamando a /functions/v1/arca-selfservice-setup. */
async function routeEdge(page: Page, transcript: string[]) {
  await page.route(/\/functions\/v1\/arca-selfservice-setup$/, async (route) => {
    const response = await route.fetch({ url: `${HARNESS}/functions/v1/arca-selfservice-setup` })
    const body = await response.text()
    transcript.push(body)
    await route.fulfill({ response, body })
  })
}

// ─── Siembra ────────────────────────────────────────────────────────────────
const rand = () => Math.random().toString(36).slice(2, 8)

function validCuit(): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  for (;;) {
    const body = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const raw = 11 - ([...body].reduce((s, c, i) => s + Number(c) * w[i], 0) % 11)
    if (raw === 10) continue
    return `${body}${raw % 11}`
  }
}

async function adminClient() {
  const d = await assertDestinoLocalSeguro()
  return createClient(d.supabaseUrl, d.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

async function createUser(email: string): Promise<string> {
  const sb = await adminClient()
  const { data, error } = await sb.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  return data.user!.id
}

async function userToken(email: string): Promise<string> {
  const d = await assertDestinoLocalSeguro()
  const sb = createCompatibleUserClient(d)
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error || !data.session) throw new Error(`login ${email}: ${error?.message}`)
  return data.session.access_token
}

/** Owner + negocio por la autoridad canónica (provision_my_business) y plan fijado para el test. */
async function seedOwner(plan: 'pro' | 'basico' = 'pro') {
  const email = `e2e-arca2b-${rand()}@e2e.local`
  const userId = await createUser(email)
  const d = await assertDestinoLocalSeguro()
  const sb = createCompatibleUserClient(d)
  await sb.auth.signInWithPassword({ email, password: PASSWORD })
  const { data, error } = await sb.rpc('provision_my_business', { p_business_name: `ARCA 2B ${rand()}` })
  await sb.auth.signOut()
  if (error) throw new Error(`provision: ${error.message}`)
  const businessId = (data as { business_id: string }).business_id
  ejecutarSQL(`UPDATE public.businesses SET subscription_plan = '${plan}', subscription_status = 'active' WHERE id = '${businessId}';`)
  // Homologación (WSASS) sólo acepta letras y números en el nombre del equipo.
  return { email, userId, businessId, cuit: validCuit(), alias: `e2earca${rand()}` }
}

async function seedMember(businessId: string, role: 'tech') {
  const email = `e2e-arca2b-${role}-${rand()}@e2e.local`
  const userId = await createUser(email)
  ejecutarSQL(`INSERT INTO public.profiles (id, user_id, business_id, role, is_active, email)
    VALUES ('${userId}', '${userId}', '${businessId}', '${role}', true, '${email}')
    ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id, role = EXCLUDED.role, is_active = true;`)
  return { email, userId }
}

async function loginUI(page: Page, email: string) {
  await page.goto('/login')
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 15_000 })
  await page.fill('[data-testid="login-email"]', email)
  await page.fill('[data-testid="login-password"]', PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await page.waitForURL(/\/(dashboard|no-business|onboarding|first-steps)/, { timeout: 25_000 })
}

async function openArcaTab(page: Page) {
  await page.goto('/settings?tab=arca')
  await expect(page.getByTestId('arca-status-card').or(page.getByTestId('arca-status-error'))).toBeVisible({ timeout: 20_000 })
}

const wizard = (page: Page) => page.getByTestId('arca-setup-wizard')

/** Una sola referencia al paso: eyebrow «Paso N de 6» + título; sin barra de progreso ni subtítulo repetido. */
async function expectSingleStep(page: Page, step: number, heading: string) {
  const dialog = page.getByRole('dialog')
  await expect(page.getByTestId('arca-setup-step')).toHaveText(`Paso ${step} de 6`)
  await expect(page.getByTestId('arca-setup-heading')).toHaveText(heading)
  await expect(dialog.locator('[role="progressbar"], .intake-progress')).toHaveCount(0)
  expect((await dialog.innerText()).match(/Paso \d de 6/g)).toEqual([`Paso ${step} de 6`])
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false })
}

async function fillFiscal(page: Page, t: { cuit: string; alias: string }) {
  await page.getByTestId('arca-setup-cuit').fill(t.cuit)
  await page.getByTestId('arca-setup-razon-social').fill('QA E2E SRL')
  await page.getByTestId('arca-setup-ambiente-homologacion').click()
  await page.getByTestId('arca-setup-punto-venta').fill('3')
  await page.getByTestId('arca-setup-alias').fill(t.alias)
}

async function prepareFromStart(page: Page, t: { cuit: string; alias: string }) {
  await page.getByTestId('arca-setup-start').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'datos_fiscales')
  await fillFiscal(page, t)
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca', { timeout: 30_000 })
}

async function downloadCsr(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('arca-setup-download').click()])
  const path = await download.path()
  const { readFileSync } = await import('node:fs')
  const pem = readFileSync(path!, 'utf8')
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+\.csr$/)
  expect(pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/)
  expect(pem).not.toMatch(LEAK)
  return pem
}

async function uploadCertificate(page: Page, certificatePem: string, name = 'arca.crt') {
  const dir = join('test-results', 'arca-phase2b-files')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${rand()}-${name}`)
  writeFileSync(file, certificatePem)
  if (await page.getByTestId('arca-setup-have-certificate').isVisible()) await page.getByTestId('arca-setup-have-certificate').click()
  await page.getByTestId('arca-setup-certificate-input').setInputFiles(file)
}

async function toVerification(page: Page, t: { cuit: string; alias: string }) {
  await prepareFromStart(page, t)
  const csrPem = await downloadCsr(page)
  const { certificatePem } = await control<{ certificatePem: string }>('sign', { csrPem })
  await uploadCertificate(page, certificatePem)
  await expect(wizard(page)).toHaveAttribute('data-screen', 'verificar_conexion', { timeout: 30_000 })
}

async function directVerify(email: string) {
  const token = await userToken(email)
  const d = await assertDestinoLocalSeguro()
  const res = await fetch(`${HARNESS}/functions/v1/arca-selfservice-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: d.anonKey, 'x-techrepair-client-contract': '1' },
    body: JSON.stringify({ action: 'verify', idempotency_key: `arca-setup-${crypto.randomUUID()}` }),
  })
  return { status: res.status, body: await res.json() as { ok: boolean; state?: string; error?: string } }
}

// ─── Flujos ─────────────────────────────────────────────────────────────────

test('@m7 ARCA 2B 1. camino feliz: datos → archivo → certificado → verificación → Listo, con UN LoginCms', async ({ page }) => {
  const t = await seedOwner('pro')
  const transcript: string[] = []
  await routeEdge(page, transcript)
  await loginUI(page, t.email)
  await openArcaTab(page)
  await expect(page.getByTestId('arca-setup-entry')).toHaveAttribute('data-entry-kind', 'start')
  await expect(page.getByTestId('arca-setup-entry-clave-fiscal')).toContainText('TechRepair Pro nunca te pide ni guarda tu Clave Fiscal')
  await shot(page, '01-entrada-sin-configurar')

  await page.getByTestId('arca-setup-start').click()
  await expect(wizard(page)).toHaveAttribute('data-step', '1')
  await expectSingleStep(page, 1, 'Datos fiscales')
  await shot(page, '02-datos-fiscales')
  // Validación local: un CUIT inválido no llega al servidor.
  await page.getByTestId('arca-setup-cuit').fill('20123456783')
  await page.getByTestId('arca-setup-prepare').click()
  await expect(page.locator('#arca-setup-cuit-error')).toContainText('dígito verificador')
  expect((await stats()).actions.prepare ?? 0).toBe(0)
  await shot(page, '03-datos-fiscales-error')

  await fillFiscal(page, t)
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca', { timeout: 30_000 })
  await expect(wizard(page)).toHaveAttribute('data-step', '3')
  await expectSingleStep(page, 3, 'Presentá el archivo en ARCA')
  await expect(page.getByTestId('arca-setup-guide')).toHaveAttribute('data-ambiente', 'homologacion')
  await shot(page, '04-presentar-en-arca')

  const csrPem = await downloadCsr(page)
  const { certificatePem } = await control<{ certificatePem: string }>('sign', { csrPem })
  await page.getByTestId('arca-setup-have-certificate').click()
  await expect(wizard(page)).toHaveAttribute('data-step', '4')
  await shot(page, '05-subir-certificado')
  await uploadCertificate(page, certificatePem)
  await expect(wizard(page)).toHaveAttribute('data-screen', 'verificar_conexion', { timeout: 30_000 })
  await expectSingleStep(page, 5, 'Verificar la conexión')
  await shot(page, '06-verificar')

  await page.getByTestId('arca-setup-verify').click()
  await expect(page.getByTestId('arca-setup-done')).toBeVisible({ timeout: 60_000 })
  await expect(wizard(page)).toHaveAttribute('data-step', '6')
  await expectSingleStep(page, 6, 'ARCA quedó conectado')
  await expect(page.getByTestId('arca-setup-done-summary')).toContainText(t.cuit.slice(0, 2))
  // El cierre describe la conexión configurada; no promete una emisión que el asistente no hizo.
  await expect(page.getByTestId('arca-setup-done-message')).toContainText('La conexión con ARCA quedó configurada correctamente')
  await expect(wizard(page)).not.toContainText(/pod[eé]s emitir|\bCAE\b/)
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await shot(page, '07-listo')
  expect((await stats()).loginCms).toBe(1)

  await page.getByTestId('arca-setup-finish').click()
  await expect(page.getByTestId('arca-status-headline')).toHaveText('Conectado', { timeout: 20_000 })
  await expect(page.getByTestId('arca-setup-entry')).toHaveAttribute('data-entry-kind', 'connected')
  await expect(page.getByText('Probar conexión')).toHaveCount(0)
  await shot(page, '08-conectado')

  // "Actualizar estado" relee sin ir a ARCA.
  await page.getByTestId('arca-refresh-status').click()
  await expect(page.getByTestId('arca-status-headline')).toHaveText('Conectado')
  expect((await stats()).loginCms).toBe(1)

  // Auditoría de fugas: ninguna respuesta del Edge al navegador lleva material.
  for (const body of transcript) expect(body).not.toMatch(LEAK)
  expect(await page.content()).not.toMatch(LEAK)
})

test('@m7 ARCA 2B 2. recargar después de generar el archivo retoma en el paso 3 y vuelve a descargarlo', async ({ page }) => {
  const t = await seedOwner('pro')
  await routeEdge(page, [])
  await loginUI(page, t.email)
  await openArcaTab(page)
  await prepareFromStart(page, t)
  const first = await downloadCsr(page)

  await page.reload()
  await openArcaTab(page)
  await expect(page.getByTestId('arca-setup-entry-step')).toContainText('Paso 3 de 6')
  await page.getByTestId('arca-setup-continue').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca')
  const again = await downloadCsr(page)
  expect(again.trim()).toBe(first.trim())
  expect((await stats()).actions.prepare).toBe(1)
})

test('@m7 ARCA 2B 3. recargar después de subir el certificado retoma en verificar', async ({ page }) => {
  const t = await seedOwner('pro')
  await routeEdge(page, [])
  await loginUI(page, t.email)
  await openArcaTab(page)
  await toVerification(page, t)

  await page.reload()
  await openArcaTab(page)
  await expect(page.getByTestId('arca-setup-entry-step')).toContainText('Paso 5 de 6')
  await page.getByTestId('arca-setup-continue').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'verificar_conexion')
  await expect(page.getByTestId('arca-setup-verify')).toBeVisible()
  expect((await stats()).loginCms).toBe(0)
})

test('@m7 ARCA 2B 4. verificado sin activar: recargar y terminar la activación NO vuelve a ARCA', async ({ page }) => {
  const t = await seedOwner('pro')
  await routeEdge(page, [])
  await loginUI(page, t.email)
  await openArcaTab(page)
  await toVerification(page, t)

  // El handler reintenta la activación una vez: fallan las dos llamadas de este verify.
  await control('mode', { failRpc: { arca_selfservice_activate: 2 } })
  await page.getByTestId('arca-setup-verify').click()
  await expect(page.getByTestId('arca-setup-error')).toHaveAttribute('data-error-code', 'ACTIVATION_PENDING', { timeout: 60_000 })
  await expect(wizard(page)).toHaveAttribute('data-screen', 'finalizar_activacion')
  expect((await stats()).loginCms).toBe(1)

  await page.reload()
  await openArcaTab(page)
  await page.getByTestId('arca-setup-continue').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'finalizar_activacion')
  await shot(page, '09-finalizar-activacion')
  await page.getByTestId('arca-setup-activate').click()
  await expect(page.getByTestId('arca-setup-done')).toBeVisible({ timeout: 30_000 })
  expect((await stats()).loginCms).toBe(1)
})

test('@m7 ARCA 2B 5 y 6. 502 ambiguo → espera sin segundo LoginCms; cancelar la conserva y la hereda el mismo equipo', async ({ page }) => {
  const t = await seedOwner('pro')
  await routeEdge(page, [])
  await loginUI(page, t.email)
  await openArcaTab(page)
  await toVerification(page, t)

  await control('mode', { wsaa: 'gateway' })
  await page.getByTestId('arca-setup-verify').click()
  // La autoridad es la espera que devuelve el servidor; el aviso de la acción no se duplica encima.
  await expect(wizard(page).getByTestId('arca-setup-hold')).toHaveAttribute('data-hold-reason', 'result_unknown', { timeout: 60_000 })
  await expect(page.getByTestId('arca-setup-error')).toHaveCount(0)
  await expect(page.getByTestId('arca-setup-verify')).toHaveCount(0)
  await shot(page, '10-espera-resultado-incierto')
  expect((await stats()).loginCms).toBe(1)

  // Ni recargando ni llamando directo al Edge hay otro LoginCms.
  await page.reload()
  await openArcaTab(page)
  await expect(page.getByTestId('arca-setup-entry').getByTestId('arca-setup-hold')).toHaveAttribute('data-hold-reason', 'result_unknown')
  await page.getByTestId('arca-setup-continue').click()
  await expect(page.getByTestId('arca-setup-verify')).toHaveCount(0)
  await control('mode', { wsaa: 'ta' })
  const direct = await directVerify(t.email)
  expect(direct.status).toBe(409)
  expect(direct.body.error ?? direct.body.state).toBe('WSAA_RESULT_UNKNOWN')
  expect((await stats()).loginCms).toBe(1)

  // 6. Cancelar pide confirmación fuerte y NO levanta la espera.
  await page.getByTestId('arca-setup-cancel').click()
  await expect(page.getByTestId('arca-setup-cancel-confirm')).toHaveAttribute('data-strong', 'true')
  await expect(page.getByTestId('arca-setup-cancel-confirm')).toContainText('no revoca nada en ARCA')
  await shot(page, '11-cancelar-confirmacion')
  await page.getByTestId('arca-setup-cancel-confirm-button').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'datos_fiscales', { timeout: 20_000 })

  // Mismo equipo (alias + CUIT): la espera vuelve a aparecer y sigue sin ofrecer verificar.
  await fillFiscal(page, t)
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca', { timeout: 30_000 })
  await expect(wizard(page).getByTestId('arca-setup-hold')).toBeVisible()
  const csrPem = await downloadCsr(page)
  const { certificatePem } = await control<{ certificatePem: string }>('sign', { csrPem })
  await uploadCertificate(page, certificatePem)
  await expect(wizard(page)).toHaveAttribute('data-screen', 'verificar_conexion', { timeout: 30_000 })
  await expect(page.getByTestId('arca-setup-verify')).toHaveCount(0)
  expect((await stats()).loginCms).toBe(1)
})

test('@m7 ARCA 2B 7. certificado equivocado: mensaje claro y no avanza', async ({ page }) => {
  const t = await seedOwner('pro')
  const transcript: string[] = []
  await routeEdge(page, transcript)
  await loginUI(page, t.email)
  await openArcaTab(page)
  await prepareFromStart(page, t)
  const { certificatePem } = await control<{ certificatePem: string }>('foreign', { cn: t.alias, serialnumber: `CUIT ${t.cuit}` })
  await uploadCertificate(page, certificatePem)
  const error = page.getByTestId('arca-setup-certificate-error')
  await expect(error).toHaveAttribute('data-error-code', 'CERTIFICATE_KEY_MISMATCH', { timeout: 30_000 })
  await expect(error).toContainText('El certificado no corresponde')
  await expect(error).not.toContainText('CERTIFICATE_KEY_MISMATCH')
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca')
  await shot(page, '12-certificado-equivocado')

  // Un archivo con clave nunca sale del navegador.
  const before = (await stats()).actions.certificate ?? 0
  const label = ['PRIVATE', 'KEY'].join(' ')
  await uploadCertificate(page, `-----BEGIN ${label}-----\nMIIE\n-----END ${label}-----\n`, 'clave.pem')
  await expect(page.getByTestId('arca-setup-certificate-error')).toContainText('contiene una clave')
  expect((await stats()).actions.certificate ?? 0).toBe(before)
  expect((await stats()).loginCms).toBe(0)
})

test('@m7 ARCA 2B 8. sin permiso (técnico): sólo lectura en la UI y el Edge lo rechaza', async ({ page }) => {
  const owner = await seedOwner('pro')
  const tech = await seedMember(owner.businessId, 'tech')
  await routeEdge(page, [])
  await loginUI(page, tech.email)
  await page.goto('/settings?tab=arca')
  // Un técnico puede no tener acceso a Configuración: en ese caso no ve el asistente en absoluto.
  const entry = page.getByTestId('arca-setup-entry')
  if (await entry.count() > 0) {
    await expect(entry).toHaveAttribute('data-entry-kind', 'read_only')
    await expect(page.getByTestId('arca-setup-start')).toHaveCount(0)
    await shot(page, '13-solo-lectura')
  }
  await expect(page.getByTestId('arca-setup-start')).toHaveCount(0)
  const direct = await directVerify(tech.email)
  expect([401, 403]).toContain(direct.status)
  expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(direct.body.error ?? direct.body.state)
  expect((await stats()).loginCms).toBe(0)
})

test('@m7 ARCA 2B 9. plan sin ARCA: estado de producto y nunca llama al asistente', async ({ page }) => {
  const t = await seedOwner('basico')
  await routeEdge(page, [])
  await loginUI(page, t.email)
  await openArcaTab(page)
  await expect(page.getByTestId('arca-status-headline')).toHaveText('No incluido en tu plan')
  await expect(page.getByTestId('arca-setup-entry')).toHaveCount(0)
  await shot(page, '14-sin-plan')
  const s = await stats()
  expect(Object.values(s.actions).reduce((a, b) => a + b, 0)).toBe(0)
})

// Hallazgo del smoke REAL de homologación (2026-09-15): WSASS rechaza '.' y '-' en el nombre del
// equipo y emite el certificado con el nombre cargado en ARCA. Acá se reproduce sin ARCA real.
test('@m7 ARCA 2B 11. homologación: el nombre con guion no sale del navegador; alfanumérico sigue; certificado con otro nombre explica qué hacer', async ({ page }) => {
  const t = await seedOwner('pro')
  const transcript: string[] = []
  await routeEdge(page, transcript)
  await loginUI(page, t.email)
  await openArcaTab(page)
  await page.getByTestId('arca-setup-start').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'datos_fiscales')
  // La sugerencia automática ya es compatible con WSASS.
  await expect(page.getByTestId('arca-setup-alias')).toHaveValue(/^[a-z0-9]{3,50}$/)
  await expect(page.getByTestId('arca-setup-fiscal')).toContainText('En homologación sólo puede contener letras y números.')

  // Válido en producción, inválido apenas se elige homologación (sin esperar al envío).
  await page.getByTestId('arca-setup-cuit').fill(t.cuit)
  await page.getByTestId('arca-setup-razon-social').fill('QA E2E SRL')
  await page.getByTestId('arca-setup-punto-venta').fill('1')
  await page.getByTestId('arca-setup-ambiente-produccion').click()
  await page.getByTestId('arca-setup-alias').fill('techrepair-demo-homo')
  await expect(page.locator('#arca-setup-alias-error')).toHaveCount(0)
  await page.getByTestId('arca-setup-ambiente-homologacion').click()
  const aliasError = page.locator('#arca-setup-alias-error')
  await expect(aliasError).toHaveText('En homologación ARCA acepta únicamente letras y números. Usá entre 3 y 50 caracteres.')
  await expect(page.getByTestId('arca-setup-alias')).toHaveAttribute('aria-invalid', 'true')

  // El navegador bloquea prepare: el Edge (y la base) reciben CERO pedidos.
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'datos_fiscales')
  await expect(aliasError).toBeVisible()
  await aliasError.scrollIntoViewIfNeeded()
  await shot(page, '19-alias-homologacion-invalido')
  expect((await stats()).actions.prepare ?? 0).toBe(0)
  expect(consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM private.arca_credential_rotations WHERE business_id = '${t.businessId}'`).n).toBe(0)

  // Con el nombre alfanumérico el flujo local sigue.
  await page.getByTestId('arca-setup-alias').fill(t.alias)
  await expect(aliasError).toHaveCount(0)
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca', { timeout: 30_000 })
  expect((await stats()).actions.prepare).toBe(1)
  await expectSingleStep(page, 3, 'Presentá el archivo en ARCA')
  await expect(page.getByTestId('arca-setup-guide-certificate')).toContainText('sólo lleva letras y números')
  await expect(page.getByTestId('arca-setup-guide-certificate-note')).toContainText('agregar certificado a DN existente')
  await expect(page.getByTestId('arca-setup-guide-authorize-note')).toContainText('esa autorización se conserva')
  await page.getByTestId('arca-setup-guide-certificate').scrollIntoViewIfNeeded()
  await shot(page, '21-guia-homologacion-dn-existente')

  // ARCA emite el certificado con OTRO nombre (lo que pasó con WSASS en el smoke): rechazo accionable, sin ARCA.
  const csrPem = await downloadCsr(page)
  const renamed = await control<{ certificatePem: string }>('sign', { csrPem, cn: 'otronombre' })
  await uploadCertificate(page, renamed.certificatePem, 'otronombre.crt')
  const certError = page.getByTestId('arca-setup-certificate-error')
  await expect(certError).toHaveAttribute('data-error-code', 'CERTIFICATE_ALIAS_MISMATCH', { timeout: 30_000 })
  await expect(certError).toContainText('El nombre del certificado no coincide con el nombre del equipo configurado. En homologación, ARCA acepta sólo letras y números.')
  await expect(certError).toContainText('Generá el certificado usando exactamente el nombre que muestra TechRepair Pro.')
  await expect(certError).not.toContainText(/CERTIFICATE_ALIAS_MISMATCH|\bCN\b|subject/)
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca')
  await shot(page, '20-nombre-del-certificado-no-coincide')
  expect((await stats()).loginCms).toBe(0)

  // Certificado con el nombre correcto → verificar → Listo con UN LoginCms.
  const { certificatePem } = await control<{ certificatePem: string }>('sign', { csrPem })
  await uploadCertificate(page, certificatePem)
  await expect(wizard(page)).toHaveAttribute('data-screen', 'verificar_conexion', { timeout: 30_000 })
  await page.getByTestId('arca-setup-verify').click()
  await expect(page.getByTestId('arca-setup-done')).toBeVisible({ timeout: 60_000 })
  expect((await stats()).loginCms).toBe(1)
  expect(consultarJSON<{ alias: string }>(`SELECT alias FROM public.arca_config WHERE business_id = '${t.businessId}'`).alias).toBe(t.alias)
  for (const body of transcript) expect(body).not.toMatch(LEAK)
})

test('@m7 ARCA 2B 10. mobile 375 y 320: pantalla completa, sin scroll horizontal y usable con el teclado', async ({ page }) => {
  const t = await seedOwner('pro')
  await routeEdge(page, [])
  await page.setViewportSize({ width: 375, height: 812 })
  await loginUI(page, t.email)
  await openArcaTab(page)
  await shot(page, '15-mobile-entrada')
  await page.getByTestId('arca-setup-start').click()
  const dialog = page.getByTestId('responsive-dialog')
  await expect(dialog).toHaveAttribute('data-mobile-presentation', 'fullscreen')
  const box = await dialog.boundingBox()
  expect(Math.round(box!.width)).toBeGreaterThanOrEqual(370)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await shot(page, '16-mobile-datos-fiscales')

  // Teclado: los radios del ambiente se eligen sin mouse y el error queda enlazado al campo.
  await page.getByTestId('arca-setup-ambiente-produccion').locator('input').focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('arca-setup-ambiente-homologacion').locator('input')).toBeChecked()
  await page.getByTestId('arca-setup-prepare').click()
  await expect(page.getByTestId('arca-setup-cuit')).toHaveAttribute('aria-describedby', 'arca-setup-cuit-error')

  await fillFiscal(page, t)
  await page.getByTestId('arca-setup-prepare').click()
  await expect(wizard(page)).toHaveAttribute('data-screen', 'presentar_en_arca', { timeout: 30_000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await shot(page, '17-mobile-presentar')

  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await shot(page, '18-mobile-320')
})
