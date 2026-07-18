// ============================================================================
// M7 7D.2/7D.3 — Fixture base de los specs M7.
//
// El globalSetup prueba el destino UNA vez, antes de todo. Esto es la segunda
// línea: vigila cada página de cada test, en tiempo real.
//
// Por qué hacen falta las dos: el guard valida contra qué backend se CONSTRUYÓ
// la app. No cubre que un test intercepte mal una ruta, que un tercero haga un
// request propio, o que quede una URL productiva hardcodeada en algún módulo.
// Acá cualquiera de esos casos rompe el test que lo causó, con el culpable a la
// vista.
//
// 7D.3 §1 — Cobertura de los tres canales por los que se puede fugar tráfico:
//   HTTP        → page.route
//   WebSocket   → page.routeWebSocket (Supabase Realtime habla wss://)
//   ServiceWorker → bloqueado en playwright.config.ts (`serviceWorkers: 'block'`),
//                   porque sus requests NO pasan por page.route y serían un
//                   agujero silencioso. El proyecto registra uno en
//                   src/hooks/useUpdateDetector.ts.
// ============================================================================
import { test as base, expect } from '@playwright/test'
import { motivoDestinoProhibido } from '../setup/destinosProhibidos'

export const test = base.extend<Record<string, never>>({
  page: async ({ page }, use) => {
    const fugas: string[] = []

    // ─── HTTP ───────────────────────────────────────────────────────────────
    // Bloquear ANTES de que salga el request, no sólo observarlo: si el destino
    // es producción, que el request no llegue a existir.
    await page.route('**/*', route => {
      const url = route.request().url()
      const motivo = motivoDestinoProhibido(url)
      if (motivo) {
        fugas.push(`HTTP · ${motivo}: ${url}`)
        return route.abort('blockedbyclient')
      }
      return route.fallback()
    })

    // ─── WebSocket ──────────────────────────────────────────────────────────
    // Supabase Realtime abre wss://<ref>.supabase.co/realtime/v1/websocket.
    // page.route NO ve eso: sin esta ruta, una suscripción realtime contra
    // producción pasaría entera desapercibida.
    await page.routeWebSocket(/.*/, ws => {
      const motivo = motivoDestinoProhibido(ws.url())
      if (motivo) {
        fugas.push(`WS · ${motivo}: ${ws.url()}`)
        return ws.close({ code: 1008, reason: 'destino prohibido' })
      }
      // Destino local: se conecta de verdad, sin tocar los mensajes.
      return ws.connectToServer()
    })

    // ─── ServiceWorker ──────────────────────────────────────────────────────
    // Cinturón y tirantes: la config ya los bloquea, pero si alguien la cambia
    // sin entender por qué, este test lo dice en vez de fallar en silencio.
    await page.addInitScript(() => {
      if ('serviceWorker' in navigator) {
        (window as unknown as { __SW_DISPONIBLE__?: boolean }).__SW_DISPONIBLE__ = true
      }
    })

    await use(page)

    if (fugas.length > 0) {
      // Se falla DESPUÉS del test: el error del test en sí suele ser más
      // informativo, pero una fuga no puede quedar en verde.
      expect(fugas, `La app intentó hablar con destinos prohibidos:\n  ${fugas.join('\n  ')}`).toEqual([])
    }
  },
})

export { expect }
