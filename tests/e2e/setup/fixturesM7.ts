// ============================================================================
// M7 7D.3 §2 — Fixtures transaccionales para los specs de idempotencia/errores.
//
// Regla del lote: el SEED crea las precondiciones estables; la OPERACIÓN que se
// prueba se ejecuta por UI. Este módulo es sólo el seed y la verificación en
// base — nunca sustituye la interacción principal.
//
// Va por `docker exec` al Postgres local (ver sqlLocal). Estructuralmente no
// puede tocar producción.
//
// Aislamiento (§18): cada escenario tiene su propio comprobante/orden con IDs
// deterministas y namespaces distintos. `resetX()` borra y recrea, así que un
// spec puede correr solo, repetido, o junto a los demás sin interferencia.
// ============================================================================
import { ejecutarSQL, consultarJSON } from './sqlLocal.ts'
import { E2E } from './seedE2E.ts'

// UUIDs por escenario. El sufijo identifica la sección para leerlos de un vistazo.
export const FIX = {
  reemplazoOk:      'e2e00000-0000-0000-0000-00000000c004', // §4
  respuestaPerdida: 'e2e00000-0000-0000-0000-00000000c005', // §5
  paymentSet:       'e2e00000-0000-0000-0000-00000000c006', // §6
  idemConflict:     'e2e00000-0000-0000-0000-00000000c007', // §7
  rotacion:         'e2e00000-0000-0000-0000-00000000c008', // §8
  periodClosed:     'e2e00000-0000-0000-0000-00000000c011', // §11
  anulado:          'e2e00000-0000-0000-0000-00000000c012', // §12
  cashClosed:       'e2e00000-0000-0000-0000-00000000c014', // §14
  dobleClick:       'e2e00000-0000-0000-0000-00000000c017', // §17
} as const

/** Comprobante factura_c con UN pago vivo. Reproducible: borra y recrea. */
export function resetComprobanteConPago(opts: {
  comprobanteId: string
  numero: string
  metodo?: string           // método del pago ORIGINAL (default transferencia, sin caja)
  total?: number
  sinPago?: boolean         // comprobante SIN cobro (para poder anularlo comercialmente)
}): void {
  const metodo = opts.metodo ?? 'transferencia'
  const total = opts.total ?? 1000

  ejecutarSQL(`
BEGIN;
-- 1. Limpieza total del namespace (append-only: hay que barrer todo lo derivado).
--    'replica' apaga los triggers, incluidos los de append-only: es la única
--    forma de que un fixture sea reproducible contra tablas inmutables. Vale
--    SOLO acá, en el stack local; ningún guard de producción se toca.
SET LOCAL session_replication_role = 'replica';
DELETE FROM public.comprobante_payment_replace_requests WHERE comprobante_id = '${opts.comprobanteId}';
-- 7D.3: faltaba barrer las anulaciones. Como son append-only, un registro de
-- una corrida ANTERIOR sobrevivía y quedaba re-vinculado al comprobante nuevo.
-- Si las dos corridas caían en días distintos, el resultado era una anulación
-- fechada ANTES de su venta, y el preflight 7B (PF5) lo cazaba —con razón—.
-- El bug era del fixture, no del modelo: pasaba desapercibido sólo porque
-- normalmente se corría todo el mismo día.
DELETE FROM public.comprobante_annulments    WHERE comprobante_id = '${opts.comprobanteId}';
DELETE FROM public.financial_movements       WHERE comprobante_id = '${opts.comprobanteId}';
DELETE FROM public.business_finance_entries  WHERE reference_comprobante_id = '${opts.comprobanteId}';
DELETE FROM public.comprobante_payments      WHERE comprobante_id = '${opts.comprobanteId}';
DELETE FROM public.finance_audit_log         WHERE entity_id = '${opts.comprobanteId}';
DELETE FROM public.comprobantes              WHERE id = '${opts.comprobanteId}';

-- 2. Comprobante en crudo (sin numeración ni sync automáticos).
INSERT INTO public.comprobantes (id, tipo, numero, estado, estado_fiscal, total, total_bruto,
       total_cobrado, saldo_pendiente, customer_id, business_id, created_by,
       punto_venta, fecha, date)
VALUES ('${opts.comprobanteId}', 'factura_c', '${opts.numero}', 'emitido', 'no_fiscal', ${total}, ${total},
       0, ${total}, '${E2E.customer}', '${E2E.business}', '${E2E.owner}',
       '0001', now(), now());
SET LOCAL session_replication_role = 'origin';

-- 3. Pago original CON triggers activos: trig_comprobante_payment_finance crea
--    su FM + BFE, y trig_comprobante_payment_sync ajusta total_cobrado/saldo.
--    Así el reemplazo tiene algo REAL que compensar (como en producción).
${opts.sinPago ? '-- (sin pago: comprobante pendiente, anulable comercialmente)' : `
INSERT INTO public.comprobante_payments (comprobante_id, business_id, amount, currency,
       amount_ars, exchange_rate, payment_method, commission_amount, date, created_by)
VALUES ('${opts.comprobanteId}', '${E2E.business}', ${total}, 'ARS',
       ${total}, 1, '${metodo}', 0, now(), '${E2E.owner}');`}
COMMIT;
`)
}

/** Cierra el período contable que cubre HOY (para provocar PERIOD_CLOSED). */
export function cerrarPeriodoHoy(): void {
  ejecutarSQL(`
DELETE FROM public.finance_period_locks WHERE business_id='${E2E.business}' AND period_start = date_trunc('month', now())::date;
INSERT INTO public.finance_period_locks (business_id, period_start, period_end, status, closed_at, closed_by, close_reason)
VALUES ('${E2E.business}', date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date,
        'closed', now(), '${E2E.owner}', 'E2E period_closed fixture');`)
}

/** Reabre / limpia el lock de período de HOY (aislamiento entre specs). */
export function reabrirPeriodoHoy(): void {
  ejecutarSQL(`DELETE FROM public.finance_period_locks WHERE business_id='${E2E.business}' AND close_reason='E2E period_closed fixture';`)
}

/** Cierra toda caja abierta del negocio (para provocar CASH_REGISTER_NOT_OPEN). */
export function cerrarCaja(): void {
  ejecutarSQL(`UPDATE public.cajas SET status='cerrada' WHERE business_id='${E2E.business}' AND status='abierta';`)
}

/** Reabre la caja sembrada (aislamiento). */
export function abrirCaja(): void {
  ejecutarSQL(`
UPDATE public.cajas SET status='abierta' WHERE id='${E2E.caja}';
INSERT INTO public.cajas (id, business_id, opened_by, status)
  VALUES ('${E2E.caja}', '${E2E.business}', '${E2E.owner}', 'abierta')
  ON CONFLICT (id) DO UPDATE SET status='abierta';`)
}

/** Anula el comprobante mediante la RPC canónica (otro actor). */
export function anularComprobante(comprobanteId: string): { ok: boolean } {
  const salida = ejecutarSQL(`
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${E2E.owner}","role":"authenticated"}', true);
\\echo __RPC__
\\pset tuples_only on
\\pset format unaligned
SELECT public.annul_comprobante_atomic('${comprobanteId}','commercial_annulment','anulación E2E',false,'annul-${comprobanteId}');
\\pset tuples_only off
\\pset format aligned
COMMIT;`)
  const lineas = salida.split('\n')
  const i = lineas.findIndex(l => l.includes('__RPC__'))
  const json = lineas.slice(i + 1).find(l => l.trim().startsWith('{'))
  return json ? JSON.parse(json) : { ok: false }
}

// ─── Verificaciones en base (§4) ─────────────────────────────────────────────

export interface EstadoReemplazo {
  pagos_totales: number
  pagos_vivos: number
  pagos_reemplazados: number
  requests_completed: number
  requests_totales: number
  fm_vivos_income: number
  fm_reversados: number
  auditorias: number
  total_cobrado_vivo: number
}

export function estadoReemplazo(comprobanteId: string): EstadoReemplazo {
  return consultarJSON<EstadoReemplazo>(`
    SELECT
      (SELECT count(*) FROM public.comprobante_payments WHERE comprobante_id='${comprobanteId}')::int AS pagos_totales,
      (SELECT count(*) FROM public.comprobante_payments WHERE comprobante_id='${comprobanteId}' AND replaced_at IS NULL)::int AS pagos_vivos,
      (SELECT count(*) FROM public.comprobante_payments WHERE comprobante_id='${comprobanteId}' AND replaced_at IS NOT NULL)::int AS pagos_reemplazados,
      (SELECT count(*) FROM public.comprobante_payment_replace_requests WHERE comprobante_id='${comprobanteId}' AND status='completed')::int AS requests_completed,
      (SELECT count(*) FROM public.comprobante_payment_replace_requests WHERE comprobante_id='${comprobanteId}')::int AS requests_totales,
      (SELECT count(*) FROM public.financial_movements WHERE comprobante_id='${comprobanteId}' AND type='income' AND source='comprobante' AND reversed_at IS NULL)::int AS fm_vivos_income,
      (SELECT count(*) FROM public.financial_movements WHERE comprobante_id='${comprobanteId}' AND reversed_at IS NOT NULL)::int AS fm_reversados,
      (SELECT count(*) FROM public.finance_audit_log WHERE entity_id='${comprobanteId}' AND action='payment_replacement')::int AS auditorias,
      COALESCE((SELECT sum(amount_ars) FROM public.comprobante_payments WHERE comprobante_id='${comprobanteId}' AND replaced_at IS NULL),0)::numeric AS total_cobrado_vivo`)
}

/**
 * Otro actor ejecuta un reemplazo canónico REAL (vía la RPC, commiteado). Es la
 * forma de "simular otro actor" del pliego §2 sin service_role en el browser: la
 * RPC exige auth.uid(), así que se fija el claim JWT dentro de la transacción.
 * Devuelve el jsonb de la RPC.
 */
export function reemplazoCanonicoOtroActor(opts: {
  comprobanteId: string
  metodo: string
  monto?: number
  idempotencyKey: string
}): { ok: boolean; error_code?: string } {
  const monto = opts.monto ?? 1000
  const salida = ejecutarSQL(`
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${E2E.owner}","role":"authenticated"}', true);
\\echo __RPC__
\\pset tuples_only on
\\pset format unaligned
SELECT public.replace_comprobante_payment('${opts.comprobanteId}','${E2E.business}','${opts.metodo}',
  ${monto},${monto},'ARS',1,'reemplazo de otro actor','${E2E.owner}',0,NULL,'${opts.idempotencyKey}');
\\pset tuples_only off
\\pset format aligned
COMMIT;`)
  // La línea de JSON queda justo después del marcador __RPC__.
  const lineas = salida.split('\n')
  const i = lineas.findIndex(l => l.includes('__RPC__'))
  const json = lineas.slice(i + 1).find(l => l.trim().startsWith('{'))
  return json ? JSON.parse(json) : { ok: false }
}

/** Estado (comercial) del comprobante. */
export function estadoComprobante(comprobanteId: string): string {
  return consultarJSON<{ estado: string }>(
    `SELECT estado FROM public.comprobantes WHERE id='${comprobanteId}'`).estado
}

/** Señal canónica de anulación (tabla de anulaciones, NO el estado legacy). */
export function esAnulado(comprobanteId: string): boolean {
  return consultarJSON<{ a: boolean }>(
    `SELECT public.is_comprobante_annulled('${comprobanteId}') AS a`).a
}

/** Método de pago del pago vivo actual (para verificar refresh tras reemplazo). */
export function metodoPagoVivo(comprobanteId: string): string | null {
  const r = consultarJSON<{ metodo: string | null }>(`
    SELECT (SELECT payment_method FROM public.comprobante_payments
             WHERE comprobante_id='${comprobanteId}' AND replaced_at IS NULL
             ORDER BY created_at DESC LIMIT 1) AS metodo`)
  return r.metodo
}

/** Las idempotency keys registradas para un comprobante (orden de creación). */
export function keysDeReemplazo(comprobanteId: string): string[] {
  const r = consultarJSON<{ keys: string[] | null }>(`
    SELECT array_agg(idempotency_key ORDER BY created_at) AS keys
      FROM public.comprobante_payment_replace_requests
     WHERE comprobante_id='${comprobanteId}'`)
  return r.keys ?? []
}

// ═══ 7D.3 · Gasto general (create_expense_with_finance) ══════════════════════
// El consumidor de esta RPC no mandaba idempotency key hasta este lote. Los
// helpers de abajo miden el efecto ECONOMICO completo, no sólo la fila de
// `expenses`: un doble submit que crease un solo expense pero dos FM seguiría
// siendo un bug, y mirando una sola tabla no se vería.

export interface EstadoGasto {
  expenses: number
  bfe: number
  fm: number
  requests: number
  keys: number
  auditorias: number
}

/**
 * Borra el gasto de prueba para que el spec sea reproducible.
 *
 * NO toca finance_audit_log ni expense_requests: las DOS son append-only por
 * diseño (M7 6A/6B) y un DELETE ahí revienta con "es append-only" —el fixture
 * fallaba en la segunda corrida, no en la primera, que es la peor forma de
 * fallar—. Tampoco hace falta limpiarlas: `estadoGasto` cuenta ambas haciendo
 * JOIN contra `expenses`, así que al borrar el gasto las filas viejas quedan
 * huérfanas y salen solas del conteo.
 *
 * Que este reset choque contra los guards es, en sí, una señal de que los
 * guards de append-only están puestos.
 */
export function resetGasto(descripcion: string): void {
  ejecutarSQL(`
    DELETE FROM public.financial_movements
     WHERE business_id='${E2E.business}' AND description='${descripcion}';
    DELETE FROM public.expenses
     WHERE business_id='${E2E.business}' AND description='${descripcion}';
    DELETE FROM public.business_finance_entries
     WHERE business_id='${E2E.business}' AND description='${descripcion}';
  `)
}

/** Efecto económico del gasto, por tabla. Todo debe valer 1 tras una operación. */
export function estadoGasto(descripcion: string): EstadoGasto {
  return consultarJSON<EstadoGasto>(`
    SELECT
      (SELECT count(*) FROM public.expenses
        WHERE business_id='${E2E.business}' AND description='${descripcion}')::int AS expenses,
      (SELECT count(*) FROM public.business_finance_entries
        WHERE business_id='${E2E.business}' AND description='${descripcion}')::int AS bfe,
      (SELECT count(*) FROM public.financial_movements
        WHERE business_id='${E2E.business}' AND description='${descripcion}')::int AS fm,
      (SELECT count(*) FROM public.expense_requests r
         JOIN public.expenses e ON e.id = r.expense_id
        WHERE e.description='${descripcion}')::int AS requests,
      (SELECT count(DISTINCT r.idempotency_key) FROM public.expense_requests r
         JOIN public.expenses e ON e.id = r.expense_id
        WHERE e.description='${descripcion}')::int AS keys,
      (SELECT count(*) FROM public.finance_audit_log a
         JOIN public.expenses e ON e.id = a.entity_id
        WHERE e.description='${descripcion}' AND a.action='operating_expense_create')::int AS auditorias
  `)
}
