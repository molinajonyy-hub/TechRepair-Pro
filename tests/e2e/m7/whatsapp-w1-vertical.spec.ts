// ============================================================================
// W1 · Vertical estándar de WhatsApp desde una orden.
//
// POR QUÉ EXISTE
// Los specs `@whatsapp` que ya había NO cubren este camino:
//   · whatsapp-actions.spec.ts:46 y :71 sí llegan a OrderDetail, pero el seed
//     local no siembra órdenes, así que se auto-saltean en verde;
//   · ninguno stubea `window.open` ni mira la URL de destino, así que ninguno
//     puede afirmar que lo que se previsualiza sea lo que recibe WhatsApp.
// Además viven en `tests/e2e/` → project `chromium`, que CI no ejecuta.
//
// Este spec vive en `tests/e2e/m7/`, que es el único project que CI corre
// (`e2e:ci-local -- --project=m7-local`), y siembra su propia orden para no
// depender de que exista uno.
//
// NO SE SIMULA EL NAVEGADOR. La versión anterior de este spec usaba un fake
// `WindowProxy` para "probar" que la pestaña de WhatsApp se reutilizaba, y dio
// falso positivo: un objeto plano acepta `opener = null` y `location.href = …`
// sin ningún modelo de seguridad, y su `closed` nunca cambia. En producción
// `web.whatsapp.com` manda `COOP: same-origin`, el WindowProxy queda severed y
// aparecía una segunda pestaña.
//
// Ahora se asevera lo que el browser hace DE VERDAD, con dos caminos separados:
//   · SIN Companion  → la app de escritorio no abre nada, y el fallback Web
//     abre una pestaña NUEVA real (se intercepta el destino para no salir a la
//     red, pero la pestaña se crea de verdad y TechRepair no se mueve).
//   · CON Companion  → se inyecta un BRIDGE de test: un `chrome.runtime` que
//     responde. NO se finge la Tabs API — el comportamiento de pestañas de la
//     extensión lo demuestra `tools/whatsapp-companion/probe.mjs` en Chromium
//     real. Acá se verifica el contrato del frontend: qué payload sale, que
//     TechRepair siga en su URL, y que se registre `opened`.
// ============================================================================
import { test, expect } from './fixtures'
import { ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

/** IDs determinísticos y propios: no se toca ningún fixture compartido. */
const W1 = {
  customer: '00000000-0000-0000-0000-00000e2ea001',
  device:   '00000000-0000-0000-0000-00000e2ea002',
  order:    '00000000-0000-0000-0000-00000e2ea003',
} as const

/** Número AR válido y ficticio: normaliza a 549 351 123 4567. */
const TEL_CRUDO       = '0351 15 1234567'
const TEL_NORMALIZADO = '5493511234567'

/** Los primeros 8 caracteres del uuid, en mayúsculas: lo que arma {numero_orden}. */
const NUMERO_ORDEN = W1.order.slice(0, 8).toUpperCase()

test.beforeAll(() => {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';

-- Idempotente: el spec puede correr N veces sobre el mismo stack.
DELETE FROM public.orders   WHERE id = '${W1.order}';
DELETE FROM public.devices  WHERE id = '${W1.device}';
DELETE FROM public.customers WHERE id = '${W1.customer}';

INSERT INTO public.customers (id, business_id, name, phone)
VALUES ('${W1.customer}', '${E2E.business}', 'Ana Gomez W1', '${TEL_CRUDO}');

INSERT INTO public.devices (id, business_id, customer_id, type, brand, model, issue)
VALUES ('${W1.device}', '${E2E.business}', '${W1.customer}',
        'smartphone', 'Samsung', 'Galaxy A54', 'No carga');

INSERT INTO public.orders (id, business_id, customer_id, device_id, status, priority)
VALUES ('${W1.order}', '${E2E.business}', '${W1.customer}', '${W1.device}', 'new', 'medium');

-- Datos del negocio: sin esta fila las variables de PERFIL quedan vacías y el
-- mensaje sale con huecos. Acá interesa el camino completo y determinista.
INSERT INTO public.whatsapp_settings
  (business_id, enabled, auto_send_enabled, business_name, business_address,
   business_whatsapp, business_instagram, business_hours, closing_message)
VALUES ('${E2E.business}', true, false, 'TechRepair E2E', 'San Martin 123',
        '3517654321', '@techrepair', 'Lun a Vie 9 a 18', '')
ON CONFLICT (business_id) DO UPDATE SET
  business_name='TechRepair E2E', business_address='San Martin 123',
  business_whatsapp='3517654321', business_instagram='@techrepair',
  business_hours='Lun a Vie 9 a 18', closing_message='';

SET LOCAL session_replication_role = 'origin';
COMMIT;
`)
})

test.afterAll(() => {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
DELETE FROM public.whatsapp_logs WHERE order_id = '${W1.order}';
DELETE FROM public.orders    WHERE id = '${W1.order}';
DELETE FROM public.devices   WHERE id = '${W1.device}';
DELETE FROM public.customers WHERE id = '${W1.customer}';
SET LOCAL session_replication_role = 'origin';
COMMIT;
`)
})

test('@m7-local W1 · el sidebar no ofrece el módulo Cloud API, y el editor sigue accesible', async ({ page }) => {
  await page.goto('/dashboard')
  await page.waitForLoadState('networkidle')

  // El item de navegación a /whatsapp (pantalla Cloud API) se retiró.
  const navWhatsApp = page.locator('.sidebar nav a[href="/whatsapp"], .sidebar-mobile nav a[href="/whatsapp"]')
  await expect(navWhatsApp, 'el item WhatsApp no va más en el sidebar').toHaveCount(0)

  // Pero las plantillas Standard se siguen editando desde Configuración.
  await page.goto('/settings?tab=whatsapp')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-testid="whatsapp-templates-settings"]')).toBeVisible({ timeout: 15_000 })

  // Y la ruta Cloud API NO se borró: sigue respondiendo.
  await page.goto('/whatsapp')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('h1, h2, .page-hdr-title, .page-title').first()).toBeVisible({ timeout: 15_000 })
})


type Pagina = import('@playwright/test').Page

/** Mensaje que el frontend le manda al Companion. Sólo estas tres claves. */
type MensajeCompanion = { type: string; phone?: string; text?: string }

/**
 * BRIDGE de test del Companion.
 *
 * Instala un `chrome.runtime` que responde, y registra lo que se le mandó. NO
 * simula la Tabs API ni el manejo de pestañas: eso lo prueba el probe en
 * Chromium real con la extensión de verdad. Acá interesa el lado de TechRepair.
 */
async function instalarBridgeCompanion(page: Pagina) {
  await page.addInitScript(() => {
    const enviados: Array<{ extId: string; mensaje: MensajeCompanion }> = []
    ;(window as unknown as { __COMPANION__: typeof enviados }).__COMPANION__ = enviados
    ;(window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (extId: string, mensaje: MensajeCompanion, cb: (r: unknown) => void) => {
          enviados.push({ extId, mensaje })
          setTimeout(() => cb(mensaje.type === 'PING'
            ? { ok: true, version: '1.0.0' }
            : { ok: true, action: 'reused', tabId: 7 }), 0)
        },
      },
    }
  })
}

const mensajesAlCompanion = (page: Pagina) =>
  page.evaluate(() => (window as unknown as { __COMPANION__: Array<{ extId: string; mensaje: MensajeCompanion }> }).__COMPANION__)

/**
 * Abre la orden y deja el preview listo. Devuelve el mensaje renderizado.
 *
 * `stubOpen` deja registrado todo `window.open` en vez de ejecutarlo. Se usa
 * para los caminos donde NINGUNA pestaña puede crearse (app de escritorio,
 * Companion). El fallback Web sí abre una de verdad y se mide como popup real.
 */
async function abrirPreview(page: Pagina, { stubOpen = true } = {}) {
  if (stubOpen) {
    await page.addInitScript(() => {
      ;(window as unknown as { __OPENS__: string[] }).__OPENS__ = []
      window.open = ((url?: string | URL) => {
        ;(window as unknown as { __OPENS__: string[] }).__OPENS__.push(String(url ?? ''))
        return {} as Window
      }) as typeof window.open
    })
  }

  await page.goto(`/orders/${W1.order}`)
  await page.waitForLoadState('networkidle')
  await page.locator('button', { hasText: /^whatsapp$/i }).first().click()
  await page.locator('[data-testid="order-whatsapp-received"]').click()

  const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
  await expect(modal, 'el preview tiene que abrirse ANTES de ir a WhatsApp').toBeVisible({ timeout: 10_000 })

  const textarea = modal.locator('[data-testid="whatsapp-preview-textarea"]')
  await expect(textarea).toBeVisible()
  await expect.poll(async () => (await textarea.inputValue()).length).toBeGreaterThan(0)

  return { modal, textarea, mensaje: await textarea.inputValue() }
}

const opens = (page: Pagina) =>
  page.evaluate(() => (window as unknown as { __OPENS__: string[] }).__OPENS__)

test('@m7-local W1 · preview resuelto y fallbacks de desktop sin Companion', async ({ page }) => {
  const llamadasCloudApi: string[] = []
  page.on('request', r => {
    const u = r.url()
    if (/whatsapp-send|whatsapp-embedded-signup|graph\.facebook\.com/.test(u)) llamadasCloudApi.push(u)
  })

  const { modal, mensaje } = await abrirPreview(page)

  // ── El render quedó resuelto, con datos reales de la orden ────────────────
  expect(mensaje, 'ninguna variable puede quedar sin resolver').not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/)
  expect(mensaje).not.toContain('undefined')
  expect(mensaje).not.toContain('NaN')
  expect(mensaje).toContain('Samsung')
  expect(mensaje).toContain('Galaxy A54')
  expect(mensaje).toContain(NUMERO_ORDEN)
  expect(mensaje).toContain('TechRepair E2E')

  // Teléfono normalizado y sin variables faltantes.
  await expect(modal).toContainText(`+${TEL_NORMALIZADO}`)
  await expect(modal.locator('[data-testid="whatsapp-variables-faltantes"]')).toHaveCount(0)

  // ── Sin Companion: los fallbacks, con la app como primaria ────────────────
  await expect(modal.locator('[data-testid="whatsapp-send-api-button"]')).toContainText(/WhatsApp Desktop/i)
  await expect(modal.locator('[data-testid="whatsapp-fallback-button"]')).toContainText(/WhatsApp Web/i)
  // Sin URL de instalación configurada NO se ofrece instalar nada.
  await expect(modal.locator('[data-testid="whatsapp-install-companion"]')).toHaveCount(0)

  // El copy avisa la pestaña nueva y no promete reutilizar nada.
  const ayuda = modal.locator('[data-testid="whatsapp-ayuda-desktop"]')
  await expect(ayuda).toContainText(/nueva pestaña/i)
  await expect(ayuda).not.toContainText(/reutiliz/i)
  await expect(modal).not.toContainText(/enviado por api/i)

  expect(llamadasCloudApi, 'el camino estándar no toca el transporte oficial').toEqual([])
})

test('@m7-local W1 · la app de escritorio no abre ninguna pestaña ni saca de TechRepair', async ({ page }) => {
  const { modal } = await abrirPreview(page)

  const botonApp = modal.locator('[data-testid="whatsapp-send-api-button"]')
  await expect(botonApp).toContainText(/WhatsApp Desktop/i)
  await expect(botonApp).toBeEnabled()
  await botonApp.click()

  // `whatsapp://` se lo lleva el sistema: sin handler no pasa nada, y en
  // ningún caso se crea una pestaña ni se abandona TechRepair.
  expect(await opens(page), 'la app NO puede usar window.open').toEqual([])
  await expect(page).toHaveURL(new RegExp(`/orders/${W1.order}$`))
  await expect(modal, 'el modal sigue ahí: TechRepair no se movió').toBeVisible()

  // Se registró el handoff como `opened`, jamás sent/delivered/read.
  await expect.poll(() => ejecutarSQL(
    `SELECT send_result FROM public.whatsapp_logs WHERE order_id = '${W1.order}' ORDER BY created_at DESC LIMIT 1;`),
    { timeout: 10_000 }).toContain('opened')
})

test('@m7-local W1 · sin Companion, WhatsApp Web abre pestaña nueva y TechRepair NO se mueve', async ({ page, context }) => {
  // Se intercepta el destino para no salir a la red, pero la pestaña se crea de
  // VERDAD: acá `window.open` no se stubea, así que lo que se mide es el
  // browsing context real que produce el navegador.
  await context.route('https://web.whatsapp.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }))

  const { modal, mensaje } = await abrirPreview(page, { stubOpen: false })

  const botonWeb = modal.locator('[data-testid="whatsapp-fallback-button"]')
  await expect(botonWeb).toBeEnabled()

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15_000 }),
    botonWeb.click(),
  ])
  await popup.waitForLoadState('domcontentloaded')

  // TechRepair se queda donde estaba: el contrato cambió respecto de PR #55.
  await expect(page, 'TechRepair no puede navegarse a WhatsApp').toHaveURL(new RegExp(`/orders/${W1.order}$`))
  await expect(modal).toBeVisible()

  const url = popup.url()
  expect(new URL(url).hostname).toBe('web.whatsapp.com')
  expect(url, 'nunca la pantalla intermedia').not.toContain('api.whatsapp.com')
  expect(url).toContain(`phone=${TEL_NORMALIZADO}`)

  // El preview es EXACTAMENTE lo que recibe WhatsApp, sin doble encoding.
  const texto = decodeURIComponent(url.slice(url.indexOf('&text=') + '&text='.length))
  expect(texto, 'lo que se ve tiene que ser lo que se manda').toBe(mensaje)
  expect(url).not.toContain('\n')
  expect(url).toContain('%0A')
  expect(url).not.toContain('%250A')

  await popup.close()
})

/**
 * CON Companion. §15: bridge controlado, sin fingir la Tabs API.
 *
 * Lo que se demuestra acá es el lado de TechRepair: un solo CTA, el payload
 * exacto, que la app no se mueva ni estrene pestañas, y que se registre
 * `opened`. Que la extensión reutilice UNA pestaña —A → B → C— lo demuestra
 * `tools/whatsapp-companion/probe.mjs` con la extensión de verdad cargada en
 * Chromium. Son responsabilidades separadas a propósito.
 */
test('@m7-local W1 · con Companion: UN solo CTA, payload exacto y TechRepair intacto', async ({ page }) => {
  const idConfigurado = process.env.VITE_WHATSAPP_COMPANION_EXTENSION_ID
  expect(idConfigurado,
    'Falta VITE_WHATSAPP_COMPANION_EXTENSION_ID en .env.e2e. Copiar el valor de .env.e2e.example: ' +
    'es un ID de prueba, no una extensión publicada.').toBeTruthy()

  await instalarBridgeCompanion(page)
  const { modal, mensaje } = await abrirPreview(page)

  // §18 · una sola acción. Sin menú de fallbacks.
  const cta = modal.locator('[data-testid="whatsapp-send-api-button"]')
  await expect(cta).toHaveText(/^Abrir WhatsApp$/i)
  await expect(modal.locator('[data-testid="whatsapp-fallback-button"]')).toHaveCount(0)
  await expect(modal.locator('[data-testid="whatsapp-install-companion"]')).toHaveCount(0)
  await expect(modal.locator('[data-testid="whatsapp-ayuda-desktop"]')).toContainText(/conectado con TechRepair/i)

  await expect(cta).toBeEnabled()
  await cta.click()

  // El payload es el del contrato, y nada más.
  await expect.poll(async () =>
    (await mensajesAlCompanion(page)).some(m => m.mensaje.type === 'OPEN_WHATSAPP_WEB'),
    { timeout: 10_000 }).toBe(true)

  const enviados = await mensajesAlCompanion(page)
  expect(enviados[0].mensaje.type, 'lo primero es el descubrimiento').toBe('PING')

  const apertura = enviados.find(m => m.mensaje.type === 'OPEN_WHATSAPP_WEB')!
  expect(apertura.extId).toBe(idConfigurado)
  expect(Object.keys(apertura.mensaje).sort()).toEqual(['phone', 'text', 'type'])
  expect(apertura.mensaje.phone).toBe(TEL_NORMALIZADO)
  expect(apertura.mensaje.text, 'lo que se ve es lo que se manda').toBe(mensaje)
  expect(JSON.stringify(apertura.mensaje), 'la URL la arma la extensión').not.toContain('web.whatsapp.com')

  // TechRepair no se mueve ni estrena pestañas.
  await expect(page).toHaveURL(new RegExp(`/orders/${W1.order}$`))
  await expect(modal).toBeVisible()
  expect(await opens(page), 'con Companion no se abre ninguna pestaña desde acá').toEqual([])
  expect(page.context().pages().length, 'sigue habiendo una sola pestaña').toBe(1)

  // Y el registro sigue siendo `opened`, jamás sent/delivered/read.
  await expect.poll(() => ejecutarSQL(
    `SELECT send_result FROM public.whatsapp_logs WHERE order_id = '${W1.order}' ORDER BY created_at DESC LIMIT 1;`),
    { timeout: 10_000 }).toContain('opened')
})
