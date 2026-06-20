/**
 * logger — sistema centralizado de logging para TechRepair Pro.
 *
 * En desarrollo: imprime todo en consola con contexto.
 * En producción: silencia INFO/DEBUG; mantiene WARN/ERROR.
 * Lleva un ring buffer de los últimos errores para diagnóstico en runtime.
 *
 * Uso:
 *   import { logger } from '../lib/logger'
 *   logger.info('POS', 'Scan exitoso', { code, product })
 *   const stop = logger.time('POS', 'scan-to-add')
 *   ...
 *   stop()  // imprime "[PERF][POS] scan-to-add 12ms"
 */

// `?.` por si import.meta.env no existe fuera de Vite (p. ej. runner de tests Node)
const isDev = import.meta.env?.DEV ?? false

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type LogContext =
  | 'POS'          // ComprobanteProModal, scanner, pagos
  | 'FINANCE'      // movimientos financieros, caja, BFE
  | 'INVENTORY'    // stock, productos, variantes
  | 'SUPPLIERS'    // compras, proveedores, CC
  | 'AUTH'         // autenticación, sesión, perfil
  | 'REALTIME'     // subscripciones, canales
  | 'SUPABASE'     // queries, errores de DB
  | 'UI'           // renders, animaciones
  | 'PERSONAL'       // Mi Guita — finanzas personales
  | 'GENERAL'

export interface LogEntry {
  level:     'info' | 'warn' | 'error' | 'debug'
  context:   LogContext
  message:   string
  data?:     unknown
  timestamp: string
  stack?:    string
}

// ─── Ring buffer de errores ───────────────────────────────────────────────────

const _errorBuffer: LogEntry[] = []
const MAX_ERRORS = 50

function bufferError(entry: LogEntry) {
  _errorBuffer.unshift(entry)
  if (_errorBuffer.length > MAX_ERRORS) _errorBuffer.pop()
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function prefix(level: string, ctx: LogContext): string {
  return `[${level.toUpperCase()}][${ctx}]`
}

// ─── API pública ──────────────────────────────────────────────────────────────

export const logger = {

  /** Información de flujo normal. Solo visible en desarrollo. */
  info(context: LogContext, message: string, ...data: unknown[]): void {
    if (isDev) console.log(prefix('info', context), message, ...data)
  },

  /** Situación inesperada que no rompe el flujo. Visible en dev + prod. */
  warn(context: LogContext, message: string, ...data: unknown[]): void {
    console.warn(prefix('warn', context), message, ...data)
  },

  /** Error grave. Siempre visible, guarda en buffer para diagnóstico. */
  error(context: LogContext, message: string, errorOrData?: unknown, ...extra: unknown[]): void {
    const entry: LogEntry = {
      level:     'error',
      context,
      message,
      data:      errorOrData,
      timestamp: new Date().toISOString(),
      stack:     errorOrData instanceof Error ? errorOrData.stack : undefined,
    }
    bufferError(entry)
    console.error(prefix('error', context), message, errorOrData, ...extra)
    // TODO: integrar Sentry / PostHog cuando corresponda
    // sentryCapture(entry)
  },

  /** Verbose para desarrollo. Silenciado siempre en producción. */
  debug(context: LogContext, message: string, ...data: unknown[]): void {
    if (isDev) console.debug(prefix('debug', context), message, ...data)
  },

  // ── Utilidades ──────────────────────────────────────────────────────────────

  /**
   * Mide el tiempo de una operación.
   * Devuelve una función stop() que imprime la duración.
   * Solo activa en desarrollo.
   *
   * @example
   * const stop = logger.time('POS', 'exact-search')
   * await doExactSearch(code)
   * stop()  // "[PERF][POS] exact-search 14ms"
   */
  time(context: LogContext, label: string): () => void {
    if (!isDev) return () => {}
    const start = performance.now()
    return () => {
      const ms = Math.round(performance.now() - start)
      console.log(`[PERF][${context}] ${label} ${ms}ms`)
    }
  },

  /**
   * Devuelve una copia del buffer de errores recientes.
   * Útil para debug panels o diagnóstico en runtime.
   */
  getErrors(): LogEntry[] {
    return [..._errorBuffer]
  },

  /** Limpia el buffer de errores. */
  clearErrors(): void {
    _errorBuffer.length = 0
  },
}

// ─── Helpers de contexto específico (shortcuts) ───────────────────────────────

export const posLogger = {
  scan:    (code: string, found: boolean) => logger.debug('POS', `scan ${found ? '✓' : '✗'} ${code}`),
  add:     (name: string, qty: number)    => logger.debug('POS', `add ×${qty} "${name}"`),
  submit:  (ms: number)                   => logger.info('POS', `cobro completado ${ms}ms`),
  error:   (msg: string, err?: unknown)   => logger.error('POS', msg, err),
}

export const financeLogger = {
  movement: (type: string, amount: number) => logger.debug('FINANCE', `${type} $${amount}`),
  error:    (msg: string, err?: unknown)   => logger.error('FINANCE', msg, err),
}
