// ============================================================================
// Charts L1 — GATE VISUAL (§44).
//
//   npx playwright test --project=m7-local --grep @visual-l1
//
// Corre autenticado como owner (storageState del globalSetup) contra el stack
// LOCAL. Recorre la matriz obligatoria:
//
//   desktop 1440 · desktop 1920 · móvil 390x844      ×      light · dark
//
// Verifica, además de capturar evidencia:
//   · las 7 tarjetas montan y quedan en un estado legible;
//   · no hay $NaN, undefined, [object Object], Infinity ni JSON crudo;
//   · los importes salen en es-AR;
//   · el capital en stock se llama "Capital en stock" y nunca "capital total";
//   · aging y vencimientos aparecen como superficies separadas;
//   · en 390px NO hay scroll horizontal global;
//   · la consola no tiene errores de la app.
//
// Las capturas quedan en tests/e2e/evidencia/charts-l1/.
// ============================================================================
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const CARDS = [
  { id: 'card-result',            titulo: 'Resultado del negocio' },
  { id: 'card-billing',           titulo: 'Facturación vs cobros' },
  { id: 'card-payment-mix',       titulo: 'Cómo cobraste' },
  { id: 'card-inventory-capital', titulo: 'Capital en stock' },
  { id: 'card-receivables',       titulo: 'Cuentas por cobrar' },
  { id: 'card-payables',          titulo: 'Deuda con proveedores' },
  { id: 'card-waterfall',         titulo: 'Cómo se construyó tu resultado' },
]

const VIEWPORTS = [
  { nombre: 'desktop-1440', width: 1440, height: 900 },
  { nombre: 'desktop-1920', width: 1920, height: 1080 },
  { nombre: 'mobile-390',   width: 390,  height: 844 },
]

const TEMAS = ['light', 'dark'] as const

/** Texto que jamás puede llegar a la pantalla. */
const BASURA = ['NaN', 'undefined', '[object Object]', 'Infinity', 'null']
/** Claves internas que no son para el usuario. */
const CLAVES_INTERNAS = [
  'net_sales', 'operating_result', 'inventory_at_cost', 'replenishment_pct',
  'v_finance_', 'accrued_cogs', 'business_id', 'bucket',
]

async function irAFinanzas(page: Page, tema: 'light' | 'dark') {
  await page.addInitScript((t) => {
    window.localStorage.setItem('techrepair_theme', t)
    window.localStorage.setItem('theme', t)
  }, tema)
  await page.goto('/finance')
  // El bloque L1 se carga con React.lazy: hay que esperar al chunk.
  await page.waitForSelector('[data-testid="finance-charts-l1"]', { timeout: 30_000 })
  // Y a que la primera tarjeta salga de `loading`.
  await expect
    .poll(async () => page.getByTestId('card-result').getAttribute('data-state'), { timeout: 30_000 })
    .not.toBe('loading')
  // Recharts anima al montar; se espera a que el SVG esté dibujado.
  await page.waitForTimeout(900)
}

test.describe('@visual-l1 Charts L1 — gate visual', () => {

  for (const vp of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`${vp.nombre} · ${tema}`, async ({ page }) => {
        const erroresConsola: string[] = []
        page.on('console', (m: ConsoleMessage) => {
          if (m.type() === 'error') erroresConsola.push(m.text())
        })
        page.on('pageerror', (e) => erroresConsola.push(String(e)))

        await page.setViewportSize({ width: vp.width, height: vp.height })
        await irAFinanzas(page, tema)

        // ── El tema realmente se aplicó ──
        const temaAplicado = await page.evaluate(() =>
          document.documentElement.getAttribute('data-theme'))
        expect(temaAplicado, 'el tema debe estar aplicado en <html>').toBe(tema)

        // ── Las 7 tarjetas están montadas y legibles ──
        for (const c of CARDS) {
          const card = page.getByTestId(c.id)
          await expect(card, `falta la tarjeta ${c.id}`).toBeVisible()
          const estado = await card.getAttribute('data-state')
          expect(['available', 'incomplete', 'empty', 'stale'],
            `${c.id} quedó en estado ${estado}`).toContain(estado)
          await expect(card.getByRole('heading', { name: c.titulo })).toBeVisible()
        }

        // ── Denominación canónica ──
        const texto = (await page.getByTestId('finance-charts-l1').innerText()).toLowerCase()
        expect(texto).toContain('capital en stock')
        expect(texto).not.toContain('capital total')
        expect(texto).not.toContain('patrimonio')
        expect(texto).not.toContain('capital invertido total')

        // ── Nada de basura ni claves internas en pantalla ──
        const textoCrudo = await page.getByTestId('finance-charts-l1').innerText()
        for (const b of BASURA) {
          expect(textoCrudo, `apareció "${b}" en pantalla`).not.toContain(b)
        }
        for (const k of CLAVES_INTERNAS) {
          expect(textoCrudo, `apareció la clave interna "${k}"`).not.toContain(k)
        }

        // ── Formato es-AR: separador de miles con punto, decimal con coma ──
        expect(textoCrudo, 'no se ve ningún importe en es-AR')
          .toMatch(/\$\s?\d{1,3}(\.\d{3})*,\d{2}/)
        // Y nunca el formato en-US (1,234.56).
        expect(textoCrudo).not.toMatch(/\$\s?\d{1,3}(,\d{3})+\.\d{2}/)

        // ── Aging y vencimientos son superficies separadas ──
        const payables = await page.getByTestId('card-payables').innerText()
        expect(payables).toContain('antigüedad')

        // ── Sin scroll horizontal global (crítico en 390px) ──
        const desborda = await page.evaluate(() =>
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
        expect(desborda, `hay scroll horizontal en ${vp.width}px`).toBe(false)

        // ── Evidencia ──
        await page.screenshot({
          path: `tests/e2e/evidencia/charts-l1/${vp.nombre}-${tema}.png`,
          fullPage: true,
        })

        // ── Consola limpia de errores de la app ──
        const relevantes = erroresConsola.filter(e =>
          !/favicon|manifest|ResizeObserver loop|Download the React DevTools/i.test(e))
        expect(relevantes, `errores de consola: ${relevantes.join(' | ')}`).toEqual([])
      })
    }
  }

  test('el bloque no rompe el panel M8 ni el resumen legacy', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await irAFinanzas(page, 'light')
    // M8 sigue montado por encima de los gráficos.
    await expect(page.getByTestId('finance-dashboard-income-card')).toBeVisible()
    await expect(page.getByTestId('finance-charts-l1')).toBeVisible()
  })
})
