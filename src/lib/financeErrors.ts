// ============================================================================
// M7 7D.3 — Mapper central de errores tipados de las RPC financieras.
//
// ┌── POR QUE EXISTE ────────────────────────────────────────────────────────┐
// │ Antes de este archivo, cada consumidor resolvía el mismo error por su    │
// │ cuenta. Dos patrones se repetían y los dos son problemas:                │
// │                                                                          │
// │  1. Literales duplicados: 'Solicitud en conflicto' aparecía copiado en   │
// │     PaymentCard y OrderCostManagement. Cambiar el texto exigía cazar     │
// │     cada copia.                                                          │
// │  2. `res?.error || 'Error al ...'` — cuando la RPC no mandaba `message`, │
// │     el fallback mostraba al usuario el CODIGO crudo ("PERIOD_CLOSED").   │
// │     Un código no le dice a nadie qué hacer.                              │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Regla: para un código CONOCIDO manda el texto canónico de acá, para que la
// misma condición se explique igual en toda la app. El `message` del server se
// usa cuando el código es desconocido — nunca se descarta en silencio.
//
// Un código desconocido NO se convierte en "algo salió mal": se muestra lo que
// se sepa y se registra el contexto sanitizado para poder diagnosticarlo.
// ============================================================================

import { logger, type LogContext } from './logger'

/** Códigos tipados que emiten las RPC financieras M7. */
export type FinanceErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'PAYMENT_SET_CHANGED'
  | 'PERIOD_CLOSED'
  | 'ALREADY_ANNULLED'
  | 'ALREADY_REVERSED'
  | 'AUDIT_FAILED'
  | 'CASH_REGISTER_NOT_OPEN'
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'

// Cada mensaje dice QUE pasó y QUE hacer. Sin nombres de tabla, sin SQL, sin
// jerga de idempotencia: el usuario no sabe lo que es una "key".
const MESSAGES: Record<FinanceErrorCode, string> = {
  IDEMPOTENCY_CONFLICT:
    'Esta operación ya se había enviado con otros datos. Revisá los importes y volvé a confirmar para registrarla como una operación nueva.',
  PAYMENT_SET_CHANGED:
    'Los cobros de este comprobante cambiaron mientras editabas. Actualizá la pantalla para ver el estado real antes de volver a intentar.',
  PERIOD_CLOSED:
    'El período contable de esa fecha está cerrado, así que no admite movimientos nuevos. Usá una fecha dentro de un período abierto o pedí que se reabra.',
  ALREADY_ANNULLED:
    'El comprobante ya está anulado. Actualizá la pantalla para ver su estado actual.',
  ALREADY_REVERSED:
    'Esta operación ya tenía una reversa registrada. No se generó una segunda.',
  AUDIT_FAILED:
    'No se pudo dejar registro de auditoría, así que la operación se deshizo completa y no quedó nada a medias. Volvé a intentar; si sigue fallando, avisá a soporte.',
  CASH_REGISTER_NOT_OPEN:
    'No hay una caja abierta para registrar el movimiento en efectivo. Abrí la caja y volvé a intentar.',
  VALIDATION_ERROR:
    'Los datos de la operación no son válidos. Revisá importes, fechas y campos obligatorios.',
  // Un error de permisos se dice como lo que es. Disfrazarlo de falla genérica
  // manda al usuario a reintentar algo que nunca va a funcionar.
  FORBIDDEN:
    'Tu usuario no tiene permiso para esta operación financiera.',
}

const KNOWN = new Set(Object.keys(MESSAGES))

/** ¿El código es uno de los tipados que conocemos? */
export function isFinanceErrorCode(code?: string | null): code is FinanceErrorCode {
  return !!code && KNOWN.has(code)
}

/**
 * Detalle interno que jamás debe llegar a la pantalla: fragmentos de SQL,
 * nombres calificados de funciones/tablas, o el stack de PL/pgSQL.
 */
function looksInternal(text: string): boolean {
  return /(\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|PL\/pgSQL|pg_temp|CONTEXT:|SQLSTATE|public\.[a-z_]+\()/i.test(text)
}

/**
 * Texto accionable para un error tipado de una RPC financiera.
 *
 * @param code    `error_code` devuelto por la RPC.
 * @param message `message` de la RPC (respaldo para códigos desconocidos).
 * @param context Contexto de log del flujo. No se muestra al usuario.
 */
export function financeErrorMessage(
  code?: string | null,
  message?: string | null,
  context: LogContext = 'FINANCE',
): string {
  if (isFinanceErrorCode(code)) return MESSAGES[code]

  const raw = (message || '').trim()

  // Desconocido: no se oculta, se registra con contexto sanitizado para poder
  // diagnosticarlo sin filtrar internals a la pantalla.
  logger.error(context, 'Código de error financiero no mapeado', { code: code || null })

  if (raw && !looksInternal(raw)) return raw

  return code
    ? `La operación no se pudo completar (${code}). Actualizá la pantalla y volvé a intentar; si persiste, avisá a soporte.`
    : 'La operación no se pudo completar. Actualizá la pantalla y volvé a intentar; si persiste, avisá a soporte.'
}
