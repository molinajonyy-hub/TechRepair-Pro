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
// NO abre WhatsApp de verdad: `window.open` se reemplaza por un espía antes de
// que cargue la página, así que la URL queda capturada y nada sale a wa.me.
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

test('@m7-local W1 · orden → plantilla → preview → WhatsApp (pestaña reutilizada)', async ({ page }) => {
  // ── Espía ANTES de que cargue nada ─────────────────────────────────────────
  //
  // No alcanza con contar `window.open` y comparar el target: el nombre de
  // ventana se RESETEA al navegar cross-origin (techrepairpro.app →
  // web.whatsapp.com), así que un diseño basado sólo en el nombre estrenaría
  // pestaña desde el segundo mensaje sin que un espía del target lo note.
  //
  // Por eso el falso WindowProxy registra también las NAVEGACIONES: eso es lo
  // que prueba que la pestaña se reutiliza de verdad.
  await page.addInitScript(() => {
    const wa = {
      aperturas: [] as [string, string][],
      navegaciones: [] as string[],
      focos: 0,
      openerSeteado: 'sin tocar' as unknown,
      cerrada: false,
    }
    ;(window as unknown as { __WA__: typeof wa }).__WA__ = wa

    window.open = ((url?: string | URL, target?: string) => {
      wa.aperturas.push([String(url ?? ''), String(target ?? '')])
      return {
        get closed() { return wa.cerrada },
        set opener(v: unknown) { wa.openerSeteado = v },
        get opener() { return wa.openerSeteado },
        location: {
          set href(u: string) { wa.navegaciones.push(u) },
          get href() { return wa.navegaciones[wa.navegaciones.length - 1] ?? '' },
        },
        focus() { wa.focos++ },
      } as unknown as Window
    }) as typeof window.open
  })

  // Toda llamada al transporte oficial de Meta queda registrada para aseverar
  // que NO ocurre. W1 tiene que funcionar sin nada de Cloud API.
  const llamadasCloudApi: string[] = []
  page.on('request', r => {
    const u = r.url()
    if (/whatsapp-send|whatsapp-embedded-signup|graph\.facebook\.com/.test(u)) llamadasCloudApi.push(u)
  })

  await page.goto(`/orders/${W1.order}`)
  await page.waitForLoadState('networkidle')

  // ── 1 · abrir el selector de plantilla desde la orden ──────────────────────
  await page.locator('button', { hasText: /^whatsapp$/i }).first().click()
  await page.locator('[data-testid="order-whatsapp-received"]').click()

  const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
  await expect(modal, 'el preview tiene que abrirse ANTES de ir a WhatsApp').toBeVisible({ timeout: 10_000 })

  const textarea = modal.locator('[data-testid="whatsapp-preview-textarea"]')
  await expect(textarea).toBeVisible()
  await expect.poll(async () => (await textarea.inputValue()).length).toBeGreaterThan(0)

  const mensaje = await textarea.inputValue()

  // ── 2 · el render quedó resuelto: ni un placeholder pendiente ──────────────
  expect(mensaje, 'ninguna variable puede quedar sin resolver').not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/)
  expect(mensaje).not.toContain('undefined')
  expect(mensaje).not.toContain('NaN')
  // Datos reales de la orden, no de un mock.
  expect(mensaje).toContain('Samsung')
  expect(mensaje).toContain('Galaxy A54')
  expect(mensaje).toContain(NUMERO_ORDEN)
  expect(mensaje).toContain('TechRepair E2E')

  // ── 3 · teléfono normalizado y sin aviso de bloqueo ────────────────────────
  await expect(modal).toContainText(`+${TEL_NORMALIZADO}`)
  await expect(modal.locator('[data-testid="whatsapp-variables-faltantes"]')).toHaveCount(0)

  // ── 4 · abrir WhatsApp ─────────────────────────────────────────────────────
  const boton = modal.locator('[data-testid="whatsapp-send-api-button"]')
  await expect(boton).toBeEnabled()
  await boton.click()

  type EstadoWa = {
    aperturas: [string, string][]; navegaciones: string[]; focos: number; openerSeteado: unknown
  }
  const leerWa = () => page.evaluate(() => (window as unknown as { __WA__: EstadoWa }).__WA__)

  const wa1 = await leerWa()

  // Se abre VACÍA con el nombre estable: about:blank sigue siendo same-origin
  // y es el único momento en que se puede cortar el opener.
  expect(wa1.aperturas, 'exactamente un open').toHaveLength(1)
  expect(wa1.aperturas[0][0]).toBe('')
  expect(wa1.aperturas[0][1]).toBe('techrepair_whatsapp')
  expect(wa1.aperturas[0][1]).not.toBe('_blank')

  // WhatsApp no queda con una referencia de vuelta a TechRepair.
  expect(wa1.openerSeteado, 'opener cortado mientras era same-origin').toBeNull()

  // Recién ahí se navega. Desktop: WhatsApp Web directo, NO la pantalla
  // intermedia de api.whatsapp.com ("Continuar en WhatsApp Web"), que era la
  // que sacaba al usuario de la pestaña y estrenaba otra.
  expect(wa1.navegaciones).toHaveLength(1)
  const url = wa1.navegaciones[0]
  expect(new URL(url).hostname).toBe('web.whatsapp.com')
  expect(url).not.toContain('api.whatsapp.com')
  expect(url).toContain(`phone=${TEL_NORMALIZADO}`)
  expect(wa1.focos).toBe(1)

  // ── 5 · el preview es EXACTAMENTE lo que recibe WhatsApp ───────────────────
  const textoDe = (u: string) => decodeURIComponent(u.slice(u.indexOf('&text=') + '&text='.length))
  expect(textoDe(url), 'lo que se ve tiene que ser lo que se manda').toBe(mensaje)

  // Encoding correcto y sin doble encoding.
  expect(url).not.toContain('\n')
  expect(url).toContain('%0A')
  expect(url).not.toContain('%250A')

  // ── 4b · el SEGUNDO handoff REUTILIZA la pestaña ──────────────────────────
  // Lo que prueba la reutilización no es el target repetido, sino que NO se
  // vuelva a llamar `open` y que la pestaña ya abierta navegue al nuevo
  // destino.
  await modal.locator('[data-testid="whatsapp-template-select"]').selectOption('ready_pickup')
  await expect.poll(async () => await textarea.inputValue()).not.toBe(mensaje)
  const mensaje2 = await textarea.inputValue()

  await expect(boton).toBeEnabled()
  await boton.click()

  const wa2 = await leerWa()

  expect(wa2.aperturas, 'el segundo mensaje NO puede estrenar pestaña').toHaveLength(1)
  expect(wa2.navegaciones, 'la MISMA pestaña navegó de nuevo').toHaveLength(2)
  expect(wa2.focos).toBe(2)

  const url2 = wa2.navegaciones[1]
  expect(url2, 'y va a un destino distinto').not.toBe(url)
  expect(new URL(url2).hostname).toBe('web.whatsapp.com')
  expect(url2).not.toContain('api.whatsapp.com')
  expect(textoDe(url2)).toBe(mensaje2)

  // ── 6 · la UI no miente ────────────────────────────────────────────────────
  const chip = modal.locator('[data-testid="whatsapp-send-status"]')
  await expect(chip).toBeVisible()
  await expect(chip).toContainText(/abierto/i)
  await expect(chip).not.toContainText(/enviado/i)
  await expect(modal).not.toContainText(/enviado por api/i)

  // ── 7 · nada de Cloud API ──────────────────────────────────────────────────
  expect(llamadasCloudApi, 'el camino estándar no puede tocar el transporte oficial').toEqual([])

  // ── 8 · lo que se registró es una APERTURA, no un envío ────────────────────
  await expect.poll(() => {
    const fila = ejecutarSQL(
      `SELECT send_result FROM public.whatsapp_logs WHERE order_id = '${W1.order}' ORDER BY created_at DESC LIMIT 1;`)
    return fila
  }, { timeout: 10_000 }).toContain('opened')
})
