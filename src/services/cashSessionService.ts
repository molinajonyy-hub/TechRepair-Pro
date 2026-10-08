// ============================================================================
// BETA-UX-1B — Apertura de caja por la RPC canónica, fuera de la pantalla Caja.
//
// ┌── QUÉ ES Y QUÉ NO ES ────────────────────────────────────────────────────┐
// │ Es un ADAPTADOR de `open_cash_session_atomic`: arma los argumentos con   │
// │ el mismo contrato que `CajaPage.handleOpenCaja` y traduce la respuesta a │
// │ tres resultados que la UI puede tratar sin adivinar.                     │
// │                                                                          │
// │ NO es una segunda autoridad. No inserta en `cajas`, no calcula saldos,   │
// │ no decide permisos. Quién puede abrir lo decide el SERVIDOR: el wrapper  │
// │ público de la RPC exige `current_user_can('finance')` antes de tocar     │
// │ nada (Lote 3, `private.require_action_authority`). El `canUseCaja` del   │
// │ navegador sólo evita ofrecer un botón que el servidor va a rechazar.     │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Abrir caja NO crea movimientos financieros: sólo deja el saldo inicial de la
// sesión. Por eso este archivo no sabe nada de cobros ni de comprobantes.
// ============================================================================

import { supabase } from '../lib/supabase'
import { financeErrorMessage, isFinanceErrorCode } from '../lib/financeErrors'
import { logger } from '../lib/logger'

/** Los cuatro medios que conoce el arqueo. El orden es el de la pantalla. */
export const CAJA_OPEN_METHODS = ['efectivo', 'transferencia', 'tarjeta', 'usd'] as const
export type CajaOpenMethod = typeof CAJA_OPEN_METHODS[number]

/**
 * Texto con el que la RPC informa que el negocio YA tiene una caja abierta.
 *
 * No viene con `error_code`: la función responde `{ ok:false, error:'Ya hay una
 * caja abierta' }` tanto por el chequeo previo como por el índice único
 * parcial. Es contrato probado server-side (`etapa6_cash_sessions_test.sql`,
 * CS4) y este literal queda atado a la migración por un test de fuente: si el
 * servidor cambia el texto, ese test falla en vez de romper la carrera en
 * silencio.
 */
export const CAJA_ALREADY_OPEN_ERROR = 'Ya hay una caja abierta'

export interface OpenCashSessionInput {
  businessId: string
  userId: string
  /** Saldo inicial por medio. `usd` va en dólares, no convertido. */
  balances: Record<CajaOpenMethod, number>
  /** Cotización que queda registrada como referencia de apertura. */
  usdRate: number
  /** Estable durante el mismo intento; ver `resolvePurchaseKey`. */
  idempotencyKey: string
}

export type OpenCashSessionResult =
  /** La caja quedó abierta. `replay` = el servidor reconoció un reintento. */
  | { status: 'opened'; cajaId: string | null; replay: boolean }
  /** No se abrió porque ya había una. El estado deseado puede estar cumplido. */
  | { status: 'already_open' }
  /** No se abrió. `message` ya es texto para mostrar. */
  | { status: 'error'; code: string | null; message: string }

interface OpenCashSessionRpcResponse {
  ok: boolean
  replay?: boolean
  caja_id?: string | null
  error?: string
  error_code?: string
  message?: string
}

/** ¿La respuesta de la RPC dice que ya había una caja abierta? */
export function isCajaAlreadyOpenResponse(res: { error?: string | null } | null | undefined): boolean {
  return !!res?.error && res.error.toLowerCase().includes(CAJA_ALREADY_OPEN_ERROR.toLowerCase())
}

export const cashSessionService = {
  async open(input: OpenCashSessionInput): Promise<OpenCashSessionResult> {
    const { data, error } = await supabase.rpc('open_cash_session_atomic', {
      p_business_id:     input.businessId,
      p_user_id:         input.userId,
      p_efectivo:        input.balances.efectivo,
      p_transferencia:   input.balances.transferencia,
      p_tarjeta:         input.balances.tarjeta,
      p_usd:             input.balances.usd,
      p_usd_rate:        input.usdRate,
      p_idempotency_key: input.idempotencyKey,
    })

    if (error) {
      // El wrapper NO devuelve `{ ok:false }` cuando falta la capacidad: LEVANTA
      // `FORBIDDEN` con SQLSTATE 42501. Se dice como lo que es, para no mandar
      // al usuario a reintentar algo que nunca va a funcionar.
      const forbidden = error.code === '42501' || error.message === 'FORBIDDEN'
      const code = forbidden ? 'FORBIDDEN' : (error.code || null)
      // El detalle de transporte (fetch caído, stack de PostgREST) queda en el
      // log; a la pantalla sólo llega el texto canónico.
      if (!forbidden) logger.error('FINANCE', 'Apertura de caja: la RPC no respondió', { code })
      return { status: 'error', code, message: financeErrorMessage(code, null, 'FINANCE') }
    }

    const res = data as OpenCashSessionRpcResponse | null
    if (res?.ok) {
      return { status: 'opened', cajaId: res.caja_id ?? null, replay: res.replay === true }
    }
    if (isCajaAlreadyOpenResponse(res)) return { status: 'already_open' }

    // La implementación histórica usa `error` para dos cosas: un código tipado
    // (`IDEMPOTENCY_CONFLICT`) o una frase en castellano («Sin acceso a este
    // negocio»). Sólo lo primero es un código; lo segundo es el mensaje.
    const typed = res?.error_code ?? (isFinanceErrorCode(res?.error) ? res?.error : null) ?? null
    return {
      status: 'error',
      code: typed,
      message: financeErrorMessage(typed, res?.message ?? res?.error, 'FINANCE'),
    }
  },
}
