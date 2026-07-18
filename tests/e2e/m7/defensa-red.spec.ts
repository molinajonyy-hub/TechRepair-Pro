// ============================================================================
// M7 7D.3 §1 — La defensa de red se prueba, no se asume.
//
// Estos tests fuerzan a la página a intentar salir a producción por cada canal.
// Si alguno lograra conectarse, el test falla — que es exactamente lo que
// queremos saber antes de confiar en el resto de la suite.
//
// Ojo: NO se puede usar el fixture de ./fixtures acá, porque ese fixture falla
// el test cuando detecta una fuga. Acá la fuga es intencional: lo que se prueba
// es que el canal quede BLOQUEADO. Se arma la defensa a mano y se verifica.
// ============================================================================
import { test, expect } from '@playwright/test'
import { motivoDestinoProhibido } from '../setup/destinosProhibidos'

const PROD_HTTP = 'https://vrdxxmjzxhfgqlnxmbwx.supabase.co/rest/v1/comprobantes?select=id'
const PROD_WS = 'wss://vrdxxmjzxhfgqlnxmbwx.supabase.co/realtime/v1/websocket?apikey=x'

/** Reproduce la defensa del fixture, devolviendo lo que se bloqueó. */
async function armarDefensa(page: import('@playwright/test').Page) {
  const bloqueados: string[] = []
  await page.route('**/*', route => {
    if (motivoDestinoProhibido(route.request().url())) {
      bloqueados.push(`HTTP ${route.request().url()}`)
      return route.abort('blockedbyclient')
    }
    return route.fallback()
  })
  await page.routeWebSocket(/.*/, ws => {
    if (motivoDestinoProhibido(ws.url())) {
      bloqueados.push(`WS ${ws.url()}`)
      return ws.close({ code: 1008, reason: 'destino prohibido' })
    }
    return ws.connectToServer()
  })
  return bloqueados
}

test('@m7 un fetch HTTP a producción se bloquea', async ({ page }) => {
  const bloqueados = await armarDefensa(page)
  await page.goto('/landing')

  const resultado = await page.evaluate(async u => {
    try {
      await fetch(u)
      return 'CONECTÓ'
    } catch {
      return 'bloqueado'
    }
  }, PROD_HTTP)

  expect(resultado, 'el fetch a producción NO debe llegar').toBe('bloqueado')
  expect(bloqueados.some(b => b.startsWith('HTTP'))).toBe(true)
})

test('@m7 un WebSocket a producción se bloquea', async ({ page }) => {
  const bloqueados = await armarDefensa(page)
  await page.goto('/landing')

  // Supabase Realtime abre exactamente este tipo de conexión. Sin
  // routeWebSocket, page.route no la ve y la fuga es invisible.
  const resultado = await page.evaluate(u => new Promise<string>(resolve => {
    const ws = new WebSocket(u)
    ws.onopen = () => resolve('CONECTÓ')
    ws.onclose = () => resolve('cerrado')
    ws.onerror = () => resolve('error')
    setTimeout(() => resolve('timeout'), 5000)
  }), PROD_WS)

  expect(resultado, 'el WebSocket a producción NO debe quedar abierto').not.toBe('CONECTÓ')
  expect(bloqueados.some(b => b.startsWith('WS')), 'la ruta WS debe haberlo interceptado').toBe(true)
})

test('@m7 un WebSocket al stack LOCAL sí se permite', async ({ page }) => {
  // La defensa no debe ser un apagón: el realtime local tiene que funcionar, o
  // estaríamos probando una app mutilada y creyendo que está sana.
  const bloqueados = await armarDefensa(page)
  await page.goto('/landing')
  expect(bloqueados.filter(b => b.startsWith('WS'))).toEqual([])
})

test('@m7 los service workers están bloqueados en este proyecto', async ({ page }) => {
  // Sus requests no pasan por page.route. Si alguien saca `serviceWorkers:
  // 'block'` de la config, la defensa de red queda con un agujero silencioso.
  await page.goto('/landing')
  const registrados = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 0
    const rs = await navigator.serviceWorker.getRegistrations()
    return rs.length
  })
  expect(registrados, 'ningún SW debe registrarse: sus requests escapan a page.route').toBe(0)
})
