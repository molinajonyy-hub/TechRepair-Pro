// ============================================================================
// BETA-UX-1F — cotización del dólar en E2E.
//
// La cotización pasó de una tarjeta de Inicio a la barra superior, así que el
// shell la pide en CADA carga de la aplicación, no sólo al visitar Inicio. La
// pide a una Edge Function (`fetch-dollar-rate` o `infodolar-cordoba`), y el
// stack local de E2E no levanta el edge runtime (ver `SERVICIOS_EXCLUIDOS` en
// scripts/e2e/ci-local.mjs): sin esto, cada pantalla recibiría un 5xx de un
// servicio que el entorno no tiene, y los specs que exigen «ningún request
// fallido» se pondrían en rojo por algo que no miden.
//
// No es una excepción en la lista de fallos tolerados de cada spec: se responde
// lo que la función responde cuando no pudo cotizar —200 con `{ error }`—, que
// es un camino real del producto. El servicio cae entonces al último valor
// guardado en la base (ninguno, en el negocio E2E) y el chip no se dibuja.
//
// Las dos funciones van por patrón exacto, no `**/functions/v1/**`: un 5xx de
// cualquier OTRA función tiene que seguir viéndose.
// ============================================================================
import type { Page } from '@playwright/test'

const FUNCIONES_DE_COTIZACION = /\/functions\/v1\/(fetch-dollar-rate|infodolar-cordoba)(\?.*)?$/

const json = (cuerpo: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(cuerpo),
})

/** El entorno no tiene fuente de cotización: la función responde «no pude». */
export async function sinFuenteDeCotizacion(page: Page): Promise<void> {
  await page.route(FUNCIONES_DE_COTIZACION, route =>
    route.fulfill(json({ error: 'e2e: el stack local no levanta el edge runtime' })))
}

/**
 * La fuente responde una cotización válida. Registrar DESPUÉS de
 * `sinFuenteDeCotizacion` (Playwright atiende primero la última ruta).
 *
 * Con una cotización válida el servicio la guarda (`exchange_rates`,
 * `dollar_rate_history`, `business_settings`). Esas escrituras se responden acá
 * sin llegar a la base: el negocio E2E es estado compartido por toda la suite y
 * una cotización guardada cambiaría lo que ven los specs que corren después.
 */
export async function conCotizacion(page: Page, venta = 1556, compra = 1530): Promise<void> {
  await page.route(FUNCIONES_DE_COTIZACION, route => {
    const cordoba = route.request().url().includes('infodolar-cordoba')
    return route.fulfill(json(cordoba
      ? { venta, compra, appliedRate: venta, mode: 'venta' }
      : { sell: venta, buy: compra, source: 'AMBITO_NACIONAL' }))
  })
  await page.route(/\/rest\/v1\/(exchange_rates|dollar_rate_history|business_settings)(\?.*)?$/, route => {
    const metodo = route.request().method()
    if (metodo === 'GET' || metodo === 'HEAD') return route.fallback()
    return route.fulfill({ status: 204, body: '' })
  })
}
