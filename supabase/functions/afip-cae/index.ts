/**
 * Edge Function: afip-cae
 * Solicita CAE (Código de Autorización Electrónica) ante WSFEv1 de AFIP/ARCA.
 * Primero obtiene token+sign via afip-wsaa (con caché), luego llama a FECAESolicitar
 * con reconciliación idempotente (FECompConsultar + FECompUltimoAutorizado) ante
 * resultados ambiguos.
 *
 * La lógica pura (resolución de endpoint, reintentos, reconciliación, armado/parseo
 * de SOAP) vive en ./logic.ts para poder testearla con `node --test` sin depender
 * de Deno.serve.
 *
 * IDEMPOTENCIA CROSS-INVOCACIÓN Y POR SERIE FISCAL (fases 3 y 4, auditoría ARCA
 * 2026-07-01):
 * `comprobante_id` y `attempt_id` son OBLIGATORIOS. El caller (comprobanteService.ts)
 * debe reclamar el derecho a emitir vía la RPC atómica `claim_comprobante_arca_emission`
 * ANTES de invocar esta función — DOS índices únicos parciales en
 * `arca_emission_attempts` son el mecanismo real de exclusión mutua:
 *   - uno por comprobante_id (dos intentos del MISMO comprobante no pueden coexistir)
 *   - uno por SERIE FISCAL (ambiente + CUIT + punto de venta + tipo de comprobante):
 *     dos comprobantes DISTINTOS de la misma serie tampoco pueden tener ambos un
 *     intento vivo, lo que evita que ambos consulten FECompUltimoAutorizado y
 *     calculen el mismo próximo número en paralelo.
 * (ver supabase/migrations/20260701150000_arca_atomic_claim.sql).
 *
 * Esta función NUNCA decide si puede emitir ni construye la identidad fiscal:
 * TODO (ambiente, cuit_emisor, punto_venta, tipo_comprobante) se lee de la fila
 * `arca_emission_attempts` (ya resuelta y validada server-side por el claim),
 * nunca del body de la request — un cliente no puede spoofear punto_venta/cuit/
 * ambiente/tipo_comprobante aunque los incluya en el body.
 *
 * Es la única escritora del resultado fiscal terminal (vía las RPCs
 * `reserve_arca_number` / `mark_arca_attempt_sent` / `complete_arca_attempt`,
 * nunca UPDATEs directos a `comprobantes`).
 *
 * Si el intento reclamado ya trae un `numero_intentado` (porque claim reutilizó
 * una fila `pending_reconciliation` del mismo comprobante), se reconcilia ESE
 * número primero — nunca se pide uno nuevo mientras exista una ambigüedad
 * previa sin resolver para esa fila.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  logStructured, todayYYYYMMDD, solicitarCAEConReconciliacion, consultarComprobante,
  getUltimoComprobante,
  type FacturaData, type EmissionOutcome,
} from './logic.ts'

// ─────────────────────────────────────────────────────────────────
// CORS — single source of truth (buildCorsHeaders + jsonResponse)
//
// Mirrors mp-subscription. Origin: an exact allowlist. We echo back ONLY the
// request's Origin when it is allowed; otherwise we send NO Access-Control-
// Allow-Origin at all (no wildcard, no canonical fallback) so an unauthorized
// origin can never read the response.
//
// Allowlist sources (each a single origin OR a comma-separated list):
//   - MP_CORS_ORIGIN  (preferred)
//   - APP_URL         (usually the same origin)
// The canonical production origins are HARD defaults so a misconfigured secret
// can never drop the real origin or fall back to a stale Vercel domain.
//
// Headers: an explicit, case-insensitive allowlist. We return ONLY the
// intersection of Access-Control-Request-Headers with that allowlist. cache-
// control and pragma are included because Chrome adds them on a hard reload;
// omitting them makes the browser fail the preflight and never send the POST.
// ─────────────────────────────────────────────────────────────────
// Both hosts are real production origins. The apex 307-redirects to www (Vercel),
// so on the live site the browser's Origin is usually https://www.techrepairpro.app.
const CANONICAL_ORIGINS = [
  'https://www.techrepairpro.app',
  'https://techrepairpro.app',
]

const stripSlash = (o: string) => o.trim().replace(/\/+$/, '')

const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(stripSlash).filter(Boolean)

const ALLOWED_ORIGINS: string[] = [
  ...new Set<string>([
    ...CANONICAL_ORIGINS,
    ...parseOrigins(Deno.env.get('MP_CORS_ORIGIN')),
    ...parseOrigins(Deno.env.get('APP_URL')),
  ]),
]

// Request headers we are willing to allow on the actual request (lower-case).
const ALLOWED_REQUEST_HEADERS = new Set<string>([
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'cache-control',
  'pragma',
])

// Fallback for non-preflight responses (where ACAH is ignored by the browser).
const DEFAULT_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type'

// Intersection of the preflight's requested headers with our allowlist.
function pickAllowedRequestHeaders(req: Request): string {
  const requested = req.headers.get('Access-Control-Request-Headers')
  if (!requested) return DEFAULT_ALLOW_HEADERS
  const allowed = requested
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && ALLOWED_REQUEST_HEADERS.has(h))
  return allowed.join(', ')
}

// The single CORS-header builder. Used by every response (preflight, success, error).
function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = stripSlash(req.headers.get('Origin') ?? '')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': pickAllowedRequestHeaders(req),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin, Access-Control-Request-Headers',
  }
  // Only emit Allow-Origin for an authorized origin; never a canonical fallback.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

// The single JSON-response builder. Always carries the CORS headers.
function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

// ──────────────────────────────────────────────
// Fila del intento — identidad fiscal AUTORITATIVA (nunca el body del cliente).
// ──────────────────────────────────────────────

interface AttemptRow {
  id: string
  comprobante_id: string
  business_id: string
  ambiente: string
  cuit_emisor: string
  punto_venta: number
  tipo_comprobante: number
  numero_intentado: number | null
  status: string
}

async function fetchAttempt(supabase: any, attemptId: string): Promise<AttemptRow | null> {
  const { data } = await supabase
    .from('arca_emission_attempts')
    .select('id, comprobante_id, business_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, numero_intentado, status')
    .eq('id', attemptId)
    .maybeSingle()
  return data ?? null
}

// ──────────────────────────────────────────────
// RPCs atómicas (supabase/migrations/20260701150000_arca_atomic_claim.sql).
// Única vía de escritura del resultado fiscal terminal — nunca UPDATEs
// directos a `comprobantes` desde acá. Best-effort en el sentido de que un
// fallo de estas llamadas se loguea pero no debe ocultar el resultado real de
// ARCA al caller (que ya reclamó el attempt_id y espera una respuesta).
// ──────────────────────────────────────────────

async function reserveNumber(supabase: any, attemptId: string, numero: number, ctx: Record<string, unknown>): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('reserve_arca_number', {
      p_attempt_id: attemptId,
      p_numero: numero,
    })
    if (error || !data?.success) {
      logStructured({ ...ctx, stage: 'persistencia', classification: 'reserve_number_failed', error: error?.message ?? data?.error })
    }
  } catch (e) {
    logStructured({ ...ctx, stage: 'persistencia', classification: 'reserve_number_failed', error: String((e as any)?.message ?? e) })
  }
}

async function markAttemptSent(supabase: any, attemptId: string, ctx: Record<string, unknown>): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('mark_arca_attempt_sent', { p_attempt_id: attemptId })
    if (error || !data?.success) {
      logStructured({ ...ctx, stage: 'persistencia', classification: 'mark_sent_failed', error: error?.message ?? data?.error })
    }
  } catch (e) {
    logStructured({ ...ctx, stage: 'persistencia', classification: 'mark_sent_failed', error: String((e as any)?.message ?? e) })
  }
}

async function completeAttempt(
  supabase: any,
  attemptId: string,
  status: 'authorized' | 'authorized_reconciled' | 'rejected' | 'pending_reconciliation',
  fields: { cae?: string; cae_vencimiento?: string; resultado?: string; observaciones?: string; error_mensaje?: string },
  ctx: Record<string, unknown>
): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('complete_arca_attempt', {
      p_attempt_id: attemptId,
      p_status: status,
      p_cae: fields.cae ?? null,
      p_cae_vencimiento: fields.cae_vencimiento ?? null,
      p_resultado: fields.resultado ?? null,
      p_observaciones: fields.observaciones ?? null,
      p_error_mensaje: fields.error_mensaje ?? null,
    })
    if (error || !data?.success) {
      logStructured({ ...ctx, stage: 'persistencia', classification: 'complete_attempt_failed', error: error?.message ?? data?.error })
    }
  } catch (e) {
    logStructured({ ...ctx, stage: 'persistencia', classification: 'complete_attempt_failed', error: String((e as any)?.message ?? e) })
  }
}

// ──────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    // Preflight — CORS headers only, no body.
    return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase    = createClient(supabaseUrl, supabaseKey)

  // Declarado antes del try para poder correlacionar también los errores tempranos
  // (body inválido, excepciones no clasificadas) en el catch de abajo.
  const correlationId = crypto.randomUUID()
  let businessIdForLog: string | undefined

  try {
    const body: FacturaData & { attempt_id?: string } = await req.json()
    const {
      comprobante_id,
      attempt_id,
      tipo_doc_receptor,
      nro_doc_receptor,
      concepto,
      importe_neto,
      importe_iva,
      alicuota_iva,
      importe_total,
      moneda       = 'PES',
      cotizacion_moneda = 1,
      fecha_cbte,
    } = body

    if (!comprobante_id || !attempt_id) {
      // No se emite fiscalmente sin una identidad local persistente y un claim
      // atómico ya reclamado — ver claim_comprobante_arca_emission.
      return jsonResponse(req, { success: false, error: 'Faltan comprobante_id / attempt_id: debe reclamarse el intento antes de invocar afip-cae' }, 400)
    }

    // ── Identidad fiscal AUTORITATIVA: se lee del intento ya reclamado, NUNCA
    //    del body. Un cliente no puede spoofear punto_venta/cuit/ambiente/
    //    tipo_comprobante aunque los incluya en la request. ──────────────────
    const attempt = await fetchAttempt(supabase, attempt_id)
    if (!attempt || attempt.comprobante_id !== comprobante_id) {
      return jsonResponse(req, { success: false, error: 'attempt_id inválido o no corresponde a comprobante_id' }, 400)
    }
    if (!['claimed', 'number_reserved', 'sent'].includes(attempt.status)) {
      return jsonResponse(req, { success: false, error: `El intento ya no está activo (status=${attempt.status})` }, 409)
    }

    const business_id = attempt.business_id
    const cuit         = attempt.cuit_emisor
    const punto_venta  = attempt.punto_venta
    const tipo_comprobante = attempt.tipo_comprobante
    const ambiente     = attempt.ambiente

    businessIdForLog = business_id
    const logCtx = { correlationId, businessId: business_id, ambiente, comprobanteId: comprobante_id, attemptId: attempt_id }
    logStructured({ ...logCtx, stage: 'start' })

    // 1. Obtener token+sign (llama internamente a afip-wsaa)
    logStructured({ ...logCtx, stage: 'auth' })
    const wsaaRes = await supabase.functions.invoke('afip-wsaa', {
      body: { business_id, service: 'wsfe' },
    })

    if (wsaaRes.error || !wsaaRes.data?.success) {
      const errMsg = wsaaRes.data?.error || wsaaRes.error?.message || 'Error al autenticar con WSAA'
      logStructured({ ...logCtx, stage: 'auth', classification: 'fatal', error: errMsg })
      return jsonResponse(req, { success: false, error: `WSAA: ${errMsg}`, correlation_id: correlationId }, 502)
    }

    const { token, sign } = wsaaRes.data as { token: string; sign: string }

    // 2. Si el intento YA trae un número (claim reutilizó una fila
    //    pending_reconciliation del MISMO comprobante), reconciliar ESE número
    //    primero — nunca pedir uno nuevo mientras exista una ambigüedad previa
    //    sin resolver para esta fila.
    if (attempt.numero_intentado != null) {
      logStructured({ ...logCtx, stage: 'reconciliacion', classification: 'intento_previo_con_numero', cbteNro: attempt.numero_intentado })
      const consulta = await consultarComprobante(
        token, sign, cuit, punto_venta, tipo_comprobante, attempt.numero_intentado,
        ambiente, logCtx
      )

      if (consulta.status === 'found') {
        const outcome: EmissionOutcome = {
          kind: 'authorized_reconciled', reconciled: true,
          cae: consulta.cae!, cae_vencimiento: consulta.cae_vencimiento || '',
          numero_cbte: consulta.numero_cbte ?? attempt.numero_intentado,
          resultado: consulta.resultado || '', observaciones: consulta.observaciones,
        }
        await completeAttempt(supabase, attempt_id, 'authorized_reconciled', outcome, logCtx)
        const nroCbteFormateado = `${String(punto_venta).padStart(4, '0')}-${String(outcome.numero_cbte).padStart(8, '0')}`
        return jsonResponse(req, {
          success: true, cae: outcome.cae, cae_vencimiento: outcome.cae_vencimiento,
          numero_comprobante: nroCbteFormateado, numero_cbte_raw: outcome.numero_cbte,
          resultado: outcome.resultado, observaciones: outcome.observaciones || null,
          reconciled: true, outcome: 'authorized_reconciled', correlation_id: correlationId,
        })
      }

      if (consulta.status === 'query_failed') {
        // Ya había una ambigüedad previa Y esta reconciliación tampoco pudo
        // confirmar nada: no avanzamos, no pedimos número nuevo, no inventamos CAE.
        const message = consulta.motivo || 'No se pudo confirmar el estado del comprobante en ARCA'
        await completeAttempt(supabase, attempt_id, 'pending_reconciliation', { error_mensaje: message }, logCtx)
        return jsonResponse(req, {
          success: false, error: message, outcome: 'pending_reconciliation',
          pending_reconciliation: true, correlation_id: correlationId,
        }, 200)
      }

      // not_found confirmado: seguro pedir un número nuevo — se procede normal.
      logStructured({ ...logCtx, stage: 'reconciliacion', classification: 'intento_previo_not_found', cbteNroAnterior: attempt.numero_intentado })
    }

    // 3. Obtener último número autorizado y determinar el próximo.
    const ultimoNro = await getUltimoComprobante(token, sign, cuit, punto_venta, tipo_comprobante, ambiente, logCtx)
    const proximoNro = ultimoNro + 1

    // 4. Reservar el número (claimed → number_reserved) ANTES de considerar
    //    enviar nada — trazado incluso si el proceso cae antes de llegar a
    //    marcar 'sent'. No se infiere que fue ENVIADO solo porque se reservó.
    await reserveNumber(supabase, attempt_id, proximoNro, logCtx)

    // 5. Recién ahora, confirmar que se va a invocar FECAESolicitar
    //    (number_reserved → sent) — si la respuesta a ESTE cliente se pierde
    //    después de este punto, una invocación futura reconcilia este número.
    await markAttemptSent(supabase, attempt_id, logCtx)

    // 6. Armar y enviar SOAP FECAESolicitar, con reconciliación idempotente
    //    (matriz de 5 casos: ver logic.ts::decidirTrasAmbiguo) si el resultado
    //    es ambiguo (timeout/reset/502/503/504).
    const fechaCbte = fecha_cbte || todayYYYYMMDD()
    const outcome = await solicitarCAEConReconciliacion({
      token, sign, cuit,
      puntoVenta: punto_venta,
      tipoComprobante: tipo_comprobante,
      cbteDesde: proximoNro,
      cbteHasta: proximoNro,
      tipoDocReceptor: tipo_doc_receptor,
      nroDocReceptor: nro_doc_receptor,
      concepto,
      fechaCbte,
      importeNeto:  importe_neto,
      importeIva:   importe_iva,
      alicuotaIva:  alicuota_iva,
      importeTotal: importe_total,
      moneda,
      cotizacion: cotizacion_moneda,
      ambiente,
    }, logCtx)

    // 7. Persistir el resultado terminal vía RPC (única escritora del CAE en
    //    `comprobantes`) y traducir a la respuesta HTTP. Se mantiene el
    //    contrato existente (success/error/cae/...) y se agregan campos
    //    ADITIVOS (outcome, reconciled, pending_reconciliation) sin romper
    //    consumidores existentes.
    switch (outcome.kind) {
      case 'authorized':
      case 'authorized_reconciled': {
        await completeAttempt(supabase, attempt_id, outcome.kind, outcome, logCtx)
        const nroCbteFormateado = `${String(punto_venta).padStart(4, '0')}-${String(outcome.numero_cbte).padStart(8, '0')}`
        return jsonResponse(req, {
          success: true,
          cae:                outcome.cae,
          cae_vencimiento:    outcome.cae_vencimiento,
          numero_comprobante: nroCbteFormateado,
          numero_cbte_raw:    outcome.numero_cbte,
          resultado:          outcome.resultado,
          observaciones:      outcome.observaciones || null,
          reconciled:         outcome.reconciled,
          outcome:            outcome.kind,
          correlation_id:     correlationId,
        })
      }
      case 'pending_reconciliation':
        await completeAttempt(supabase, attempt_id, 'pending_reconciliation', { error_mensaje: outcome.message }, logCtx)
        // success:false a propósito — mantiene el contrato "no marcar como
        // emitido" para clientes viejos, mientras que clientes nuevos pueden
        // leer `pending_reconciliation`/`outcome` para mostrar el mensaje
        // específico en vez del genérico de conectividad.
        return jsonResponse(req, {
          success: false,
          error: outcome.message,
          outcome: 'pending_reconciliation',
          pending_reconciliation: true,
          correlation_id: correlationId,
        }, 200)
      case 'not_sent':
        // Nunca se llegó a enviar nada a ARCA — el intento queda 'sent' (por
        // mark_arca_attempt_sent) sin resultado; se completa como
        // pending_reconciliation para que la serie/comprobante sigan
        // bloqueados hasta una reconciliación explícita, en vez de cerrar la
        // puerta con un 'rejected' definitivo (podría haber llegado por otra
        // vía de red que sí alcanzó a AFIP).
        await completeAttempt(supabase, attempt_id, 'pending_reconciliation', { error_mensaje: outcome.message }, logCtx)
        return jsonResponse(req, {
          success: false,
          error: outcome.message,
          outcome: 'not_sent',
          correlation_id: correlationId,
        }, 502)
      case 'rejected':
      default:
        await completeAttempt(supabase, attempt_id, 'rejected', { error_mensaje: outcome.message }, logCtx)
        return jsonResponse(req, {
          success: false,
          error: outcome.message,
          outcome: 'rejected',
          correlation_id: correlationId,
        }, 200)
    }

  } catch (err: any) {
    logStructured({
      correlationId,
      businessId: businessIdForLog,
      stage: 'unhandled',
      error: String(err?.message ?? err),
    })
    return jsonResponse(req, {
      success: false,
      error: err?.message || 'Error interno en CAE',
      correlation_id: correlationId,
    }, 500)
  }
})
