// ============================================================================
// M7 7D.3 §3 — Observabilidad de RPCs económicas en E2E.
//
// Un grabador que se engancha a los requests a /rest/v1/rpc/<fn> y captura lo
// justo para distinguir, ante un fallo:
//   · doble clic        → 2 requests, MISMA key, sin espera entre medio
//   · retry real        → 2 requests, MISMA key, tras un error/timeout
//   · replay            → misma key, la 2ª respuesta dice "ya aplicado"
//   · nueva intención   → key DISTINTA (el payload cambió)
//   · error terminal    → respuesta con error_code, sin reintento
//
// NO registra secretos: nunca guarda headers (ahí viven el JWT y la apikey),
// ni el token. Sólo el cuerpo económico y el código de respuesta.
// ============================================================================
import type { Page, Request } from '@playwright/test'

export interface LlamadaRPC {
  rpc: string
  idempotencyKey: string | null
  /** Campos económicos del payload, sin nada sensible. */
  payload: Record<string, unknown>
  status: number
  /** error_code del cuerpo de respuesta, si la RPC lo devolvió. */
  errorCode: string | null
  /** ¿La respuesta parece un replay (ya aplicado / idempotente)? */
  replay: boolean
  tMs: number
}

// Sólo estos campos del payload se conservan. Todo lo demás (incluido cualquier
// token que un futuro cambio metiera en el body) se descarta explícitamente.
const CAMPOS_ECONOMICOS = new Set([
  'p_comprobante_id', 'p_business_id', 'p_payment_method', 'p_amount', 'p_amount_ars',
  'p_currency', 'p_exchange_rate', 'p_notes', 'p_commission_amount', 'p_payment_provider',
  'p_idempotency_key', 'p_order_id', 'p_expense_id', 'p_payment_id', 'p_reason', 'p_index',
])

function nombreRPC(url: string): string | null {
  const m = url.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)/i)
  return m ? m[1] : null
}

function extraerPayload(req: Request): Record<string, unknown> {
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(req.postData() ?? '{}')
  } catch { /* sin body legible */ }
  const limpio: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (CAMPOS_ECONOMICOS.has(k)) limpio[k] = v
  }
  return limpio
}

export class GrabadorRPC {
  readonly llamadas: LlamadaRPC[] = []

  private constructor(private readonly page: Page, private readonly filtro: (fn: string) => boolean) {}

  /** Empieza a grabar. `rpcs` limita a esas funciones (default: todas). */
  static async iniciar(page: Page, rpcs?: string[]): Promise<GrabadorRPC> {
    const filtro = rpcs ? (fn: string) => rpcs.includes(fn) : () => true
    const g = new GrabadorRPC(page, filtro)
    page.on('requestfinished', async req => {
      const fn = nombreRPC(req.url())
      if (!fn || !g.filtro(fn) || req.method() !== 'POST') return
      const payload = extraerPayload(req)
      let status = 0, errorCode: string | null = null, replay = false
      try {
        const resp = await req.response()
        status = resp?.status() ?? 0
        const txt = (await resp?.text()) ?? ''
        errorCode = leerErrorCode(txt)
        replay = pareceReplay(txt)
      } catch { /* respuesta interceptada/perdida: se registra igual con status 0 */ }
      g.llamadas.push({
        rpc: fn,
        idempotencyKey: (payload['p_idempotency_key'] as string) ?? null,
        payload,
        status,
        errorCode,
        replay,
        tMs: Date.now(),
      })
    })
    return g
  }

  /** Llamadas a una RPC concreta, en orden. */
  de(rpc: string): LlamadaRPC[] {
    return this.llamadas.filter(l => l.rpc === rpc)
  }

  /** Keys distintas vistas para una RPC. */
  keysDistintas(rpc: string): string[] {
    return [...new Set(this.de(rpc).map(l => l.idempotencyKey).filter((k): k is string => !!k))]
  }

  limpiar(): void {
    this.llamadas.length = 0
  }
}

/** Lee `error_code` del cuerpo de respuesta de una RPC (jsonb {ok,error_code}). */
function leerErrorCode(txt: string): string | null {
  try {
    const j = JSON.parse(txt)
    return (j?.error_code as string) ?? null
  } catch {
    return null
  }
}

/**
 * ¿La respuesta es un replay? Las RPC M7 marcan el segundo resultado de una misma
 * key con `replay: true` (replace_comprobante_payment) o `idempotent_replay`
 * (checkout/order). Ver 6F.3 §8.5.
 */
function pareceReplay(txt: string): boolean {
  try {
    const j = JSON.parse(txt)
    return j?.replay === true || j?.idempotent_replay === true || j?.already_applied === true
  } catch {
    return false
  }
}
