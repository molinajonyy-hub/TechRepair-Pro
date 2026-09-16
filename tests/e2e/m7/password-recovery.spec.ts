// ============================================================================
// BETA-GATE-1 · Lote B — «¿Olvidaste tu contraseña?» end-to-end REAL.
//
// Nada de mocks: GoTrue del stack local manda el correo, se lee de Mailpit, el
// navegador abre el enlace tal cual (303 de /auth/v1/verify con los tokens en el
// fragmento) y la contraseña se cambia contra el mismo GoTrue. Después se prueba
// con el password grant que la vieja dejó de servir y la nueva sí.
//
//   1. flujo completo por UI + la URL con tokens no queda ni en la barra ni
//      detrás de «atrás» + el enlace usado dos veces cae en «vencido»
//   2. anti-enumeración: email inexistente y pedido repetido (429) → mismo mensaje
//   3. /reset-password sin enlace no muestra el formulario (sin sesión y con
//      una sesión normal)
//   4. enlaces rotos: otp_expired y tokens basura → pantallas propias
//   5. usuario Google-only: el recovery no le borra la identidad OAuth
//
// Emails sintéticos (`@e2e.local`), creados y borrados por el propio spec.
// Mailpit: `[inbucket] port` de supabase/config.toml, siempre en 127.0.0.1.
// ============================================================================
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal.ts'

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const PASS_VIEJA = 'e2e-recovery-vieja-123'
const PASS_NUEVA = 'e2e-recovery-nueva-456'
const NEUTRO = /Si existe una cuenta asociada a ese correo, te enviamos instrucciones/

function mailpitBase(): string {
  const toml = readFileSync('supabase/config.toml', 'utf-8')
  const bloque = toml.split(/^\[inbucket\]\s*$/m)[1] ?? ''
  const port = bloque.match(/^\s*port\s*=\s*(\d+)/m)?.[1]
  if (!port) throw new Error('supabase/config.toml no declara [inbucket] port')
  return `http://127.0.0.1:${port}`
}

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
  await fetch(`${mailpitBase()}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: 'DELETE' }).catch(() => {})
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

async function correosPara(email: string): Promise<Array<{ ID: string }>> {
  const r = await fetch(`${mailpitBase()}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
  if (!r.ok) throw new Error(`Mailpit respondió ${r.status}`)
  return ((await r.json()) as { messages?: Array<{ ID: string }> }).messages ?? []
}

/** Espera el correo «Reset your password» y devuelve su enlace (sin loguearlo). */
async function enlaceDeRecovery(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const [msg] = await correosPara(email)
    if (msg) {
      const full = (await (await fetch(`${mailpitBase()}/api/v1/message/${msg.ID}`)).json()) as { HTML?: string; Text?: string }
      const html = (full.HTML ?? '').replace(/&amp;/g, '&')
      const href = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).find(h => h.includes('/auth/v1/verify') && h.includes('type=recovery'))
      if (href) return href
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`No llegó el correo de recovery para ${email}`)
}

async function pedirEnlacePorUI(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-forgot-link').click()
  await page.getByTestId('login-forgot-email').fill(email)
  await page.getByTestId('login-forgot-submit').click()
  await expect(page.getByTestId('login-success')).toContainText(NEUTRO, { timeout: 20_000 })
}

const estado = (page: Page) => page.getByTestId('reset-password-page')

test('@m7 1. recovery real: correo → nueva contraseña → la vieja deja de servir, sin tokens en la URL', async ({ page }) => {
  const email = unico('flujo')
  await borrarUsuario(email)
  await crearUsuario(email)
  expect(await passwordGrant(email, PASS_VIEJA), 'precondición: la vieja sirve').toBe(200)

  // Todo lo que el navegador muestra en la barra y todo lo que loguea.
  const urls: string[] = []
  page.on('framenavigated', f => { if (f === page.mainFrame()) urls.push(f.url()) })
  const consola: string[] = []
  page.on('console', m => consola.push(m.text()))
  let accessToken = ''
  page.on('response', r => {
    const loc = r.headers()['location'] ?? ''
    const m = loc.match(/access_token=([^&]+)/)
    if (r.url().includes('/auth/v1/verify') && m) accessToken = m[1]
  })

  await pedirEnlacePorUI(page, email)
  const enlace = await enlaceDeRecovery(email)
  expect(enlace).toContain('redirect_to=')
  expect(decodeURIComponent(enlace.split('redirect_to=')[1] ?? '')).toMatch(/\/auth\/callback$/)

  // Abrir el enlace del correo tal cual.
  await page.goto(enlace)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'formulario', { timeout: 25_000 })
  expect(accessToken.length, 'GoTrue emitió el fragmento con tokens').toBeGreaterThan(20)

  // Nunca pasó por el Dashboard ni por onboarding antes del formulario.
  expect(urls.some(u => /\/(dashboard|onboarding|no-business)/.test(u)), urls.join(' | ')).toBe(false)
  // La barra ya no tiene fragmento ni tokens.
  expect(page.url()).not.toContain('#')
  expect(page.url()).not.toContain('access_token')
  // Ni sessionStorage ni la consola tienen el token.
  const sessionDump = await page.evaluate(() => JSON.stringify({ ...sessionStorage }))
  expect(sessionDump).not.toContain(accessToken)
  expect(consola.join('\n')).not.toContain(accessToken)

  // Validación local: no coinciden.
  await page.getByTestId('reset-password-new').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-confirm').fill(`${PASS_NUEVA}x`)
  await page.getByTestId('reset-password-submit').click()
  await expect(page.getByTestId('reset-password-confirm-error')).toContainText('no coinciden')

  // Mostrar/ocultar.
  await page.getByTestId('reset-password-toggle-new').click()
  await expect(page.getByTestId('reset-password-new')).toHaveAttribute('type', 'text')

  await page.getByTestId('reset-password-confirm').fill(PASS_NUEVA)
  await page.getByTestId('reset-password-submit').click()
  await expect(estado(page)).toHaveAttribute('data-estado', 'listo', { timeout: 20_000 })

  // La contraseña cambió DE VERDAD en GoTrue.
  expect(await passwordGrant(email, PASS_VIEJA), 'la vieja ya no entra').toBe(400)
  expect(await passwordGrant(email, PASS_NUEVA), 'la nueva entra').toBe(200)

  // Sigue a la app con sesión (sin negocio, el guard lo lleva al alta).
  await page.getByTestId('reset-password-continue').click()
  await expect(page).toHaveURL(/\/(dashboard|no-business|onboarding)/, { timeout: 25_000 })

  // «Atrás» no devuelve la URL con tokens.
  const atras = [] as string[]
  for (let i = 0; i < 3; i++) {
    const r = await page.goBack().catch(() => null)
    if (!r && page.url() === 'about:blank') break
    atras.push(page.url())
  }
  expect(atras.join(' | ')).not.toContain('access_token')

  // El MISMO enlace, otra vez: GoTrue lo rechaza y la app lo dice.
  await page.goto(enlace)
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 25_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido', { timeout: 25_000 })
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)
  await page.getByTestId('reset-password-request-new').click()
  await expect(page).toHaveURL(/\/login\?modo=recuperar$/)
  await expect(page.getByTestId('login-forgot-form')).toBeVisible()

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

test('@m7 2. anti-enumeración: email inexistente y pedido repetido reciben el mismo mensaje', async ({ page }) => {
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

test('@m7 4. enlaces rotos: otp_expired y tokens inválidos tienen su pantalla y limpian la URL', async ({ page }) => {
  await page.goto('/auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=')
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 20_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:vencido')

  await page.goto('/auth/callback#access_token=basura&expires_in=3600&refresh_token=basura&token_type=bearer&type=recovery')
  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 20_000 })
  await expect(estado(page)).toHaveAttribute('data-estado', 'invalido:invalido', { timeout: 25_000 })
  expect(page.url()).not.toContain('basura')
  await expect(page.getByTestId('reset-password-new')).toHaveCount(0)
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
