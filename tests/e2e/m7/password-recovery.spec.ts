// ============================================================================
// BETA-GATE-1 · Lote B + PRE-BETA-2D — «¿Olvidaste tu contraseña?» end-to-end REAL.
//
// Nada de mocks: GoTrue del stack local manda el correo, se lee de Mailpit, el
// navegador abre el enlace tal cual y la contraseña se cambia contra el mismo
// GoTrue. Después se prueba con el password grant que la vieja dejó de servir y
// la nueva sí.
//
// PRE-BETA-2D: el stack local usa las plantillas versionadas
// (supabase/templates/*.html), así que el correo de recovery trae el contrato
// que 2E pega en producción: `/auth/callback?token_hash=…&type=recovery`.
//
//   1. token_hash real: correo → escáner (GET sin JS) → OTRO navegador abre el
//      enlace → verifyOtp → formulario → la vieja deja de servir, la nueva
//      entra → el enlace reusado cae en «vencido» → el token no queda ni en la
//      barra ni detrás de «atrás»
//   1b. LEGACY: el enlace `/auth/v1/verify` (plantilla `ConfirmationURL`, la de
//      producción hasta 2E) sigue funcionando por el fragmento: los correos ya
//      enviados antes del cambio no se rompen
//   2. la UI no revela si la cuenta existe: email inexistente y pedido repetido
//      (429) → mismo mensaje
//   3. /reset-password sin enlace no muestra el formulario (sin sesión y con
//      una sesión normal)
//   4. enlaces rotos: `otp_expired` SIN evidencia de recovery → pantalla neutra
//      (no «restablecer contraseña»); CON evidencia → «vencido»; tokens basura
//   5. usuario Google-only: el recovery no le borra la identidad OAuth
//   6. token_hash VENCIDO de verdad (reloj del servidor) → «vencido», la
//      contraseña no cambia
//
// Emails sintéticos (`@e2e.local`), creados y borrados por el propio spec.
// Mailpit: `[local_smtp] port` de supabase/config.toml (tests/e2e/setup/mailpit.ts).
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal.ts'
import { borrarCorreos, correosPara, esEnlaceTokenHash, esperarEnlace, ultimoCorreo } from '../setup/mailpit.ts'

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const PASS_VIEJA = 'e2e-recovery-vieja-123'
const PASS_NUEVA = 'e2e-recovery-nueva-456'
const NEUTRO = /Si existe una cuenta asociada a ese correo, te enviamos instrucciones/
const RECOVERY_REQUEST_MARKER_KEY = 'techrepair.auth.recovery-requested'

const unico = (tag: string) => `e2e-recovery-${tag}-${Date.now()}@e2e.local`

async function admin() {
  const d = await assertDestinoLocalSeguro()
  return { d, sb: createClient(d.supabaseUrl, d.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } }) }
}

async function crearUsuario(email: string, password = PASS_VIEJA): Promise<string> {
  const { sb } = await admin()
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
  return data.user.id
}

async function borrarUsuario(email: string): Promise<void> {
  const { sb } = await admin()
  const { data } = await sb.auth.admin.listUsers({ perPage: 1000 })
  const u = data?.users?.find(x => x.email === email)
  if (u) await sb.auth.admin.deleteUser(u.id).catch(() => {})
  await borrarCorreos(email)
}

/** Password grant real contra GoTrue: la prueba de que la contraseña cambió. */
async function passwordGrant(email: string, password: string): Promise<number> {
  const { d } = await admin()
  const r = await fetch(`${d.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: d.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return r.status
}

/** Espera el correo de recovery y devuelve su enlace `token_hash` (sin loguearlo). */
const enlaceDeRecovery = (email: string) => esperarEnlace(email, esEnlaceTokenHash('recovery'))

async function pedirEnlacePorUI(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-forgot-link').click()
  await page.getByTestId('login-forgot-email').fill(email)
  await page.getByTestId('login-forgot-submit').click()
  await expect(page.getByTestId('login-success')).toContainText(NEUTRO, { timeout: 20_000 })
}

/** «Atrás» hasta tres veces: devuelve las URLs visitadas. */
async function historialHaciaAtras(page: Page): Promise<string> {
  const atras = [] as string[]
  for (let i = 0; i < 3; i++) {
    const r = await page.goBack().catch(() => null)
    if (!r && page.url() === 'about:blank') break
    atras.push(page.url())
  }
  return atras.join(' | ')
}

const estado = (page: Page) => page.getByTestId('reset-password-page')

test('@m7 1. recovery token_hash real: escáner + otro navegador → nueva contraseña, la vieja deja de servir, sin token en la URL', async ({ page, browser, baseURL }) => {
  const email = unico('flujo')
  await borrarUsuario(email)
  await crearUsuario(email)
  expect(await passwordGrant(email, PASS_VIEJA), 'precondición: la vieja sirve').toBe(200)

  await pedirEnlacePorUI(page, email)
  const enlace = await enlaceDeRecovery(email)

  // El contrato de la plantilla versionada: la app, no GoTrue.
  const url = new URL(enlace)
  expect(url.origin).toBe(new URL(baseURL!).origin)
  expect(url.pathname).toBe('/auth/callback')
  expect(url.searchParams.get('type')).toBe('recovery')
  expect(enlace).not.toContain('/auth/v1/verify')
  const tokenHash = url.searchParams.get('token_hash')!
  expect(tokenHash.length).toBeGreaterThan(20)

  // Asunto y soporte de la plantilla versionada.
  const correo = await ultimoCorreo(email)
  expect(correo?.subject).toBe('Restablecé tu contraseña — TechRepair Pro')
  expect(correo?.html).toContain('techrepairpro.soporte@gmail.com')

  // Un escáner de correo hace GET sin ejecutar JS: con token_hash eso NO
  // consume el token (el enlace apunta a la app; el POST /verify lo hace el JS).
  expect((await fetch(enlace)).status).toBe(200)

  // Cross-device: el enlace se abre en OTRO navegador, sin nada del que lo pidió.
  const otro = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const p2 = await otro.newPage()
  const urls: string[] = []
  p2.on('framenavigated', f => { if (f === p2.mainFrame()) urls.push(f.url()) })
  const consola: string[] = []
  p2.on('console', m => consola.push(m.text()))

  await p2.goto(enlace)
  await expect(p2).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(p2)).toHaveAttribute('data-estado', 'formulario', { timeout: 25_000 })

  // Nunca pasó por el Dashboard ni por onboarding antes del formulario.
  expect(urls.some(u => /\/(dashboard|onboarding|no-business)/.test(u)), urls.join(' | ')).toBe(false)
  // La barra ya no tiene el token; ni sessionStorage ni la consola.
  expect(p2.url()).not.toContain('token_hash')
  expect(p2.url()).not.toContain(tokenHash)
  const sessionDump = await p2.evaluate(() => JSON.stringify({ ...sessionStorage }))
  expect(sessionDump).not.toContain(tokenHash)
  expect(consola.join('\n')).not.toContain(tokenHash)

  // Política: 7 caracteres no pasa el formulario.
  await p2.getByTestId('reset-password-new').fill('corta12')
  await p2.getByTestId('reset-password-confirm').fill('corta12')
  await p2.getByTestId('reset-password-submit').click()
  await expect(p2.getByTestId('reset-password-new-error')).toContainText('al menos 8')

  await p2.getByTestId('reset-password-new').fill(PASS_NUEVA)
  await p2.getByTestId('reset-password-confirm').fill(PASS_NUEVA)
  await p2.getByTestId('reset-password-submit').click()
  await expect(estado(p2)).toHaveAttribute('data-estado', 'listo', { timeout: 20_000 })

  // La contraseña cambió DE VERDAD en GoTrue.
  expect(await passwordGrant(email, PASS_VIEJA), 'la vieja ya no entra').toBe(400)
  expect(await passwordGrant(email, PASS_NUEVA), 'la nueva entra').toBe(200)

  await p2.getByTestId('reset-password-continue').click()
  await expect(p2).toHaveURL(/\/(dashboard|no-business|onboarding)/, { timeout: 25_000 })

  // «Atrás» no devuelve la URL con el token.
  expect(await historialHaciaAtras(p2)).not.toContain('token_hash')

  // El MISMO enlace, otra vez: GoTrue lo rechaza y la app lo dice como recovery
  // (el `type=recovery` del enlace ES la evidencia).
  await p2.goto(enlace)
  await expect(p2).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(p2)).toHaveAttribute('data-estado', 'invalido:vencido', { timeout: 25_000 })
  await expect(p2.getByTestId('reset-password-new')).toHaveCount(0)
  await p2.getByTestId('reset-password-request-new').click()
  await expect(p2).toHaveURL(/\/login\?modo=recuperar$/)
  await expect(p2.getByTestId('login-forgot-form')).toBeVisible()
  await otro.close()

  // Y el login por UI con la nueva funciona en una sesión limpia.
  await page.context().clearCookies()
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.goto('/login')
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(PASS_NUEVA)
  await page.getByTestId('login-submit').click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 25_000 })

  await borrarUsuario(email)
})

test('@m7 1b. LEGACY: el enlace /auth/v1/verify (fragmento) sigue funcionando durante la transición', async ({ page, baseURL }) => {
  const email = unico('legacy')
  await borrarUsuario(email)
  await crearUsuario(email)

  // Como en producción antes de 2E: el usuario pidió el enlace en este navegador…
  await pedirEnlacePorUI(page, email)
  // …y el correo trae `{{ .ConfirmationURL }}`. Ese enlace es exactamente el
  // `action_link` que genera la admin API (no manda correo).
  const { sb } = await admin()
  const { data, error } = await sb.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${new URL(baseURL!).origin}/auth/callback` },
  })
  expect(error).toBeNull()
  const enlace = data!.properties!.action_link
  expect(enlace).toContain('/auth/v1/verify')
  expect(enlace).toContain('type=recovery')

  let accessToken = ''
  page.on('response', r => {
    const m = (r.headers()['location'] ?? '').match(/access_token=([^&]+)/)
    if (r.url().includes('/auth/v1/verify') && m) accessToken = m[1]
  })

  await page.goto(enlace)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'formulario', { timeout: 25_000 })
  expect(accessToken.length, 'GoTrue emitió el fragmento con tokens').toBeGreaterThan(20)
  expect(page.url()).not.toContain('#')
  expect(page.url()).not.toContain('access_token')
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain(accessToken)

  await page.getByTestId('reset-password-new').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-confirm').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-submit').click()
  await expect(estado(page)).toHaveAttribute('data-estado', 'listo', { timeout: 20_000 })
  expect(await passwordGrant(email, PASS_VIEJA)).toBe(400)
  expect(await passwordGrant(email, PASS_NUEVA)).toBe(200)
  expect(await historialHaciaAtras(page)).not.toContain('access_token')

  // Reusado: `otp_expired` sin `type`, pero este navegador pidió un recovery →
  // se nombra como recovery vencido.
  await page.goto(enlace)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido', { timeout: 25_000 })

  await borrarUsuario(email)
})

test('@m7 2. la UI no revela si la cuenta existe: email inexistente y pedido repetido reciben el mismo mensaje', async ({ page }) => {
  const inexistente = unico('nadie')
  await borrarUsuario(inexistente)
  await pedirEnlacePorUI(page, inexistente)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await new Promise(r => setTimeout(r, 2_000))
  expect(await correosPara(inexistente), 'a un email inexistente no se le manda nada').toHaveLength(0)

  const existente = unico('repetido')
  await borrarUsuario(existente)
  await crearUsuario(existente)
  const recover: number[] = []
  page.on('response', r => { if (r.url().includes('/auth/v1/recover')) recover.push(r.status()) })

  await page.goto('/login?modo=recuperar')
  await page.getByTestId('login-forgot-email').fill(existente)
  await page.getByTestId('login-forgot-submit').click()
  await expect(page.getByTestId('login-success')).toContainText(NEUTRO, { timeout: 20_000 })
  await page.getByTestId('login-forgot-submit').click()
  await expect.poll(() => recover.length, { timeout: 20_000 }).toBe(2)

  // MEDIDO: el segundo pedido del MISMO email existente es 429 en GoTrue…
  expect(recover[1]).toBe(429)
  // …y la pantalla no lo delata.
  await expect(page.getByTestId('login-success')).toContainText(NEUTRO)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(/security purposes|only request this/i)

  await borrarUsuario(existente)
})

test('@m7 3. /reset-password sin enlace no muestra el formulario, ni sin sesión ni con una sesión normal', async ({ page }) => {
  await page.goto('/reset-password')
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:sin_sesion', { timeout: 20_000 })
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)

  const email = unico('normal')
  await borrarUsuario(email)
  await crearUsuario(email)
  await page.goto('/login')
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(PASS_VIEJA)
  await page.getByTestId('login-submit').click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 25_000 })

  await page.goto('/reset-password')
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:sin_sesion', { timeout: 20_000 })
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)

  await borrarUsuario(email)
})

test('@m7 4. enlaces rotos: otp_expired sin evidencia → pantalla neutra; con evidencia → vencido; basura → inválido', async ({ page }) => {
  const USADO = '/auth/callback#error=access_denied&error_code=otp_expired&error_description=TechRepair+fue+hackeado&sb='

  // Sin evidencia de recovery en este navegador: podría ser un alta, un magic
  // link o un cambio de email. NO se lo presenta como «restablecer contraseña».
  await page.goto(USADO)
  await expect(page).toHaveURL(/\/login\?motivo=enlace_vencido$/, { timeout: 20_000 })
  await expect(page.getByTestId('login-error')).toContainText('venció o ya se usó')
  await expect(page.locator('body')).not.toContainText('Cada enlace para restablecer la contraseña')
  // Y el texto de la URL jamás se pinta.
  await expect(page.locator('body')).not.toContainText(/hackeado/i)
  expect(page.url()).not.toContain('#')

  // Con evidencia (este navegador pidió un recovery): «vencido».
  await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ v: 1, at: Date.now() })), RECOVERY_REQUEST_MARKER_KEY)
  await page.goto(USADO)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 20_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido')
  await page.evaluate(k => localStorage.removeItem(k), RECOVERY_REQUEST_MARKER_KEY)

  // Fragmento con tokens basura.
  await page.goto('/auth/callback#access_token=basura&expires_in=3600&refresh_token=basura&token_type=bearer&type=recovery')
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 20_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:invalido', { timeout: 25_000 })
  expect(page.url()).not.toContain('basura')
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)

  // token_hash inventado con type=recovery: GoTrue lo rechaza → vencido.
  await page.goto('/auth/callback?token_hash=basurabasurabasurabasura&type=recovery')
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 20_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido', { timeout: 25_000 })
  expect(page.url()).not.toContain('basura')
})

test('@m7 5. usuario Google-only: puede recuperar y conserva su identidad de Google', async ({ page }) => {
  const email = unico('google')
  await borrarUsuario(email)
  const id = await crearUsuario(email)

  // Se convierte en un usuario creado por Google: sin contraseña, identidad google, sin identidad email.
  ejecutarSQL(`
    UPDATE auth.users
       SET encrypted_password = '',
           raw_app_meta_data = '{"provider":"google","providers":["google"]}'::jsonb
     WHERE id = '${id}';
    DELETE FROM auth.identities WHERE user_id = '${id}';
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    VALUES ('e2e-google-sub-${id}', '${id}',
            jsonb_build_object('sub', 'e2e-google-sub-${id}', 'email', '${email}', 'email_verified', true),
            'google', now(), now(), now());
  `)
  expect(await passwordGrant(email, PASS_NUEVA), 'precondición: sin contraseña').toBe(400)

  await pedirEnlacePorUI(page, email)
  const enlace = await enlaceDeRecovery(email)
  await page.goto(enlace)
  await expect(estado(page)).toHaveAttribute('data-estado', 'formulario', { timeout: 25_000 })
  await page.getByTestId('reset-password-new').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-confirm').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-submit').click()
  await expect(estado(page)).toHaveAttribute('data-estado', 'listo', { timeout: 20_000 })

  // La identidad de Google sigue intacta.
  const despues = consultarJSON<{ google: number; providers: string }>(
    `SELECT (SELECT count(*)::int FROM auth.identities WHERE user_id = '${id}' AND provider = 'google') AS google,
            (SELECT raw_app_meta_data->>'providers' FROM auth.users WHERE id = '${id}') AS providers`,
  )
  expect(despues.google).toBe(1)
  expect(despues.providers).toContain('google')
  // Y ahora también entra con email + contraseña.
  expect(await passwordGrant(email, PASS_NUEVA)).toBe(200)

  await borrarUsuario(email)
})

test('@m7 6. token_hash vencido de verdad (reloj del servidor) → «vencido» y la contraseña no cambia', async ({ page }) => {
  const email = unico('vencido')
  await borrarUsuario(email)
  const id = await crearUsuario(email)

  await pedirEnlacePorUI(page, email)
  const enlace = await enlaceDeRecovery(email)

  // Se envejece el pedido dos horas (el OTP local vence a la hora, como prod).
  ejecutarSQL(`
    UPDATE auth.users SET recovery_sent_at = now() - interval '2 hours' WHERE id = '${id}';
    UPDATE auth.one_time_tokens SET created_at = now() - interval '2 hours' WHERE user_id = '${id}';
  `)

  await page.goto(enlace)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido', { timeout: 25_000 })
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)
  expect(await passwordGrant(email, PASS_VIEJA), 'la contraseña no cambió').toBe(200)

  await borrarUsuario(email)
})
