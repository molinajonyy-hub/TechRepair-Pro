import { supabase } from '../lib/supabase';
import {
  CBTE_TIPO,
  cbteTipoFacturaParaNotaCredito,
  cbteTipoNotaCreditoParaFactura,
  esTipoFiscal,
  fiscalIdentity,
  resolverCbteTipo,
} from '../lib/fiscalIdentity';
import ArcaService from './arcaService';
import { requireFeature } from '../utils/requireFeature';
import { computeCheckoutRequestHash } from '../lib/checkoutIdempotency';
import { logger } from '../lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TipoComprobante = 'remito' | 'factura_a' | 'factura_c' | 'nota_credito';
export type TipoLinea       = 'producto' | 'servicio' | 'repuesto' | 'otro';
export type EstadoComercial = 'pendiente' | 'parcial' | 'pagado' | 'anulado';
// pendiente_conciliacion: FECAESolicitar tuvo un resultado ambiguo (timeout/502/503/504)
// y ni siquiera FECompConsultar pudo confirmarlo. Requiere el nuevo CHECK constraint de
// supabase/migrations/20260701140000_arca_pending_reconciliation_state.sql (no aplicada aún).
export type EstadoFiscal    = 'no_fiscal' | 'pendiente_emision' | 'pendiente_conciliacion' | 'emitido' | 'error_emision' | 'anulado_fiscal';
export type MedioPago       = 'efectivo' | 'transferencia' | 'tarjeta_debito' | 'tarjeta_credito' | 'qr' | 'mixto' | 'otro' | 'cuenta_corriente';

export interface ComprobanteItem {
  id?: string;
  comprobante_id?: string;
  business_id?: string;
  descripcion: string;
  tipo_linea: TipoLinea;
  cantidad: number;
  precio_unitario: number;
  descuento_linea: number;    // porcentaje 0-100
  subtotal: number;
  costo_unitario: number;
  costo_total: number;
  currency: 'ARS' | 'USD';
  exchange_rate: number;
  inventory_id?: string | null;
  orden?: number;
}

export interface ComprobantePago {
  payment_method: MedioPago;
  payment_provider?: string;
  amount: number;
  currency: 'ARS' | 'USD';
  exchange_rate?: number;
  commission_rate?: number;   // 0.0-1.0
}

export interface Comprobante {
  id: string;
  business_id: string;
  order_id?: string | null;
  customer_id?: string | null;
  // Columnas en español (columnas originales en DB)
  tipo: TipoComprobante;
  numero: string | null;
  punto_venta: string;
  fecha: string;
  subtotal: number;
  impuestos: number;
  total: number;
  estado: 'borrador' | 'emitido' | 'anulado';
  // Columnas en inglés (agregadas por migración)
  type?: TipoComprobante;
  number?: string | null;
  date?: string;
  tax?: number;
  status?: string;
  estado_comercial?: EstadoComercial;
  estado_fiscal?: EstadoFiscal;
  es_fiscal?: boolean;
  emitir_en_arca?: boolean;
  numero_fiscal?: string | null;
  observaciones?: string | null;
  currency: 'ARS' | 'USD';
  total_ars: number;
  total_usd: number;
  exchange_rate: number;
  descuento_total: number;
  recargo_total: number;
  total_bruto: number;
  total_cobrado: number;
  saldo_pendiente: number;
  total_comisiones: number;
  total_neto: number;
  condicion_fiscal?: string | null;
  cae?: string | null;
  cae_vencimiento?: string | null;
  afip_response?: any;
  tipo_comprobante_fiscal?: string | null;
  comprobante_original_id?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  // Relaciones (opcionales)
  items?: ComprobanteItem[];
  customer?: { id: string; name: string; phone?: string; email?: string } | null;
  pagos?: ComprobantePago[];
}

export interface CrearComprobanteInput {
  tipo: TipoComprobante;
  punto_venta?: string;
  condicion_fiscal?: string;
  customer_id?: string | null;
  order_id?: string | null;
  observaciones?: string;
  exchange_rate?: number;
  es_fiscal?: boolean;
  emitir_en_arca?: boolean;
  items: {
    descripcion: string;
    tipo_linea?: TipoLinea;
    cantidad: number;
    precio_unitario: number;
    descuento_linea?: number;
    costo_unitario?: number;
    currency?: 'ARS' | 'USD';
    exchange_rate?: number;
    inventory_id?: string | null;
    applied_price_type?: 'minorista' | 'mayorista' | 'manual' | null;
  }[];
  pagos?: ComprobantePago[];
  business_id: string;
  created_by?: string;
  caja_id?: string | null;
  /** Cuando es true, omite crear entradas en business_finance_entries y financial_movements.
   *  Usar cuando el comprobante se genera desde ModalCobro, que ya registró el movimiento. */
  skip_finance_entry?: boolean;
  /**
   * Identifica el INTENTO COMERCIAL (no la request HTTP) ante la RPC atómica
   * create_comprobante_checkout_atomic. Generarla UNA vez en el cliente
   * (crypto.randomUUID()) y conservarla durante doble click/timeout/retry —
   * ver src/lib/checkoutIdempotency.ts. Si no se provee, crear() genera una
   * de un solo uso (protege esa llamada puntual, pero no sobrevive un
   * refresh/retry manual del caller) — los callers nuevos deberían siempre
   * pasarla explícitamente. El request_hash NUNCA se recibe por parámetro —
   * crear() lo calcula siempre internamente a partir del carrito ya
   * validado, así dos llamadas con el mismo input SIEMPRE producen el mismo
   * hash (sin depender de que dos implementaciones independientes coincidan).
   */
  idempotency_key?: string;
}

// Tasas de comisión por proveedor (estimadas) — sin Mercado Pago en flujo POS
export const COMMISSION_RATES: Record<string, number> = {
  'debito':               0.0080,
  'posnet_debito':        0.0080,
  'posnet_credito':       0.0250,
  'getnet_debito':        0.0075,
  'getnet_credito':       0.0230,
  'banco_transferencia':  0,
  'efectivo':             0,
  'otro':                 0,
};

export const PROVIDER_LABELS: Record<string, string> = {
  'posnet':       'Posnet',
  'getnet':       'Getnet',
  'banco':        'Banco',
  'personalizado':'Personalizado',
};

// Condición fiscal receptor → CondicionIVAReceptorId de AFIP
// https://www.afip.gob.ar/ws/WSFE-v1/WSFEv1.xsd
const CONDICION_IVA_RECEPTOR: Record<string, number> = {
  'Consumidor Final':         5,
  'Responsable Inscripto':    1,
  'Responsable No Inscripto': 2,
  'No Responsable':           3,
  'Exento':                   4,
  'IVA Exento':               4,
  'Monotributo':              6,
  'Monotributista':           6,
  'Sujeto No Categorizado':   7,
  'Proveedor del Exterior':   8,
  'Cliente del Exterior':     9,
};

/** Devuelve el CondicionIVAReceptorId a partir del string de condicion_fiscal. */
function condicionIvaId(condicionFiscal?: string | null): number {
  if (!condicionFiscal) return 5; // default: Consumidor Final
  return CONDICION_IVA_RECEPTOR[condicionFiscal] ?? 5;
}

// ─── Errores ARCA — clasificación para UI ──────────────────────────────────────
// Mismos marcadores que supabase/functions/afip-cae/index.ts::classifyFetchError.
// Distingue errores de conectividad (DNS, timeout, conexión) — donde el motivo
// técnico no debe mostrarse al usuario — de rechazos fiscales legítimos de AFIP
// (validación, punto de venta, numeración), que sí son información accionable.
const ARCA_TRANSIENT_MARKERS = [
  'dns error', 'name or service not known', 'failed to lookup address',
  'connection reset', 'econnreset',
  'connection refused', 'econnrefused',
  'timed out', 'timeout',
];

export function isArcaConnectionError(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return ARCA_TRANSIENT_MARKERS.some(m => lower.includes(m));
}

export const ARCA_PENDING_RECONCILIATION_TITLE = 'Emisión pendiente de verificación';
export const ARCA_PENDING_RECONCILIATION_MESSAGE =
  'ARCA podría haber recibido la solicitud, pero no se pudo confirmar la respuesta. ' +
  'No vuelvas a emitir el comprobante hasta completar la verificación automática.';

export const ARCA_CONNECTION_ERROR_TITLE = 'No se pudo conectar con ARCA';
export const ARCA_CONNECTION_ERROR_MESSAGE =
  'El cobro quedó registrado y el comprobante quedó pendiente de emisión. Podés reintentarlo desde Comprobantes.';

/**
 * Un rechazo fiscal de ARCA puede traer varios mensajes concatenados con ' | '
 * (ver afip-cae/logic.ts::parseFECAEResponse): el primero es el motivo
 * accionable del rechazo; los siguientes suelen ser avisos informativos
 * genéricos (p.ej. "IMPORTANTE: ... Condicion Frente al IVA del receptor...").
 * Separa el principal del detalle para que la UI muestre el accionable
 * prominente y el resto como detalle expandible — nunca se descarta nada.
 * Cualquier mensaje que no sea un rechazo ARCA se devuelve intacto.
 */
export function splitArcaRejectionMessage(message?: string | null): { principal: string; detalle: string | null } {
  if (!message) return { principal: '', detalle: null };
  if (!message.includes('rechazó el comprobante')) return { principal: message, detalle: null };
  const idx = message.indexOf(' | ');
  if (idx === -1) return { principal: message, detalle: null };
  return { principal: message.slice(0, idx).trim(), detalle: message.slice(idx + 3).trim() };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcularLinea(item: CrearComprobanteInput['items'][0], globalRate: number) {
  const qty       = item.cantidad || 0;
  const price     = item.precio_unitario || 0;
  const disc      = Math.min(item.descuento_linea || 0, 100) / 100;
  const rate      = item.exchange_rate || globalRate || 1;
  const baseTotal = qty * price * (1 - disc);
  const subtotalARS = (item.currency || 'ARS') === 'USD' ? baseTotal * rate : baseTotal;
  return { baseTotal, subtotalARS, rate };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const comprobanteService = {

  // ── Obtener comprobantes ────────────────────────────────────────────────────

  async getAll(businessId: string, filters?: {
    estado?: string;
    tipo?: TipoComprobante;
    clienteId?: string;
    from?: string;
    to?: string;
  }): Promise<Comprobante[]> {
    let q = supabase
      .from('comprobantes')
      .select(`
        *,
        customer:customers(id, name, phone, email)
      `)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (filters?.estado) q = q.or(`estado.eq.${filters.estado},status.eq.${filters.estado}`);
    if (filters?.tipo)   q = q.or(`tipo.eq.${filters.tipo},type.eq.${filters.tipo}`);
    if (filters?.clienteId) q = q.eq('customer_id', filters.clienteId);
    if (filters?.from)   q = q.gte('created_at', filters.from);
    if (filters?.to)     q = q.lte('created_at', filters.to + 'T23:59:59');

    const { data, error } = await q;
    if (error) throw error;
    return (data || []) as Comprobante[];
  },

  async getById(id: string, businessId: string): Promise<Comprobante | null> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select(`
        *,
        customer:customers(id, name, phone, email, address),
        items:comprobante_items(*),
        pagos:comprobante_payments(*)
      `)
      .eq('id', id)
      .eq('business_id', businessId)
      .single();

    if (error) return null;
    return data as Comprobante;
  },

  // ── Recuperación de checkout incierto (fase 9 — timeout/refresh/cierre) ────
  /**
   * Consulta el estado de un intento de checkout por business_id+idempotency_key
   * (get_checkout_request_status, read-only). Permite a la UI resolver un
   * timeout, un refresh del navegador, o el cierre accidental del modal sin
   * arriesgarse a crear una segunda venta: si ya existe un comprobante para
   * esa key, se recupera y se continúa (o se muestra) en vez de reintentar
   * la creación desde cero.
   */
  async getCheckoutStatus(businessId: string, idempotencyKey: string): Promise<{
    found: boolean;
    checkoutStatus?: string;
    comprobanteId?: string;
    estadoFiscal?: string;
    cae?: string;
    error?: string;
  }> {
    const { data, error } = await supabase.rpc('get_checkout_request_status', {
      p_business_id: businessId,
      p_idempotency_key: idempotencyKey,
    });
    if (error) return { found: false, error: error.message };
    if (!data?.found) return { found: false };
    return {
      found: true,
      checkoutStatus: data.checkout_status,
      comprobanteId: data.comprobante_id ?? undefined,
      estadoFiscal: data.estado_fiscal ?? undefined,
      cae: data.cae ?? undefined,
      error: data.error ?? undefined,
    };
  },

  // ── Generar número ──────────────────────────────────────────────────────────

  async generarNumero(tipo: string, businessId: string, puntoVenta = '0001'): Promise<string> {
    const { data, error } = await supabase.rpc('generar_numero_comprobante', {
      p_tipo:        tipo,
      p_business_id: businessId,
      p_punto_venta: puntoVenta,
    });
    if (error) throw new Error('Error al generar número: ' + error.message);
    return data as string;
  },

  // ── Claim atómico + emisión ARCA ─────────────────────────────────────────────
  /**
   * Única puerta de entrada a ARCA desde el cliente. Reclama el derecho a
   * emitir vía la RPC atómica `claim_comprobante_arca_emission` — DOS índices
   * únicos parciales en `arca_emission_attempts` son el mecanismo real de
   * exclusión mutua (no un guard en memoria): uno por comprobante_id y uno por
   * SERIE FISCAL (ambiente+CUIT+punto de venta+tipo), este último resuelto y
   * validado 100% server-side dentro de la RPC — nunca se le pasan por
   * parámetro desde acá. Solo si el resultado es 'acquired' se llama a la Edge
   * Function. El resultado terminal (CAE, rechazo o pendiente de conciliación)
   * lo escribe `afip-cae` server-side vía `complete_arca_attempt` — este
   * helper NUNCA escribe campos fiscales directamente en `comprobantes`.
   *
   * Usada por crear(), emitir() y crearNotaCredito() — mismo mecanismo para
   * comprobantes normales y notas de crédito (cada una con su propia serie).
   */
  async _claimYEmitirArca(
    businessId: string,
    comprobanteId: string,
    datosFactura: Omit<Parameters<typeof ArcaService.emitirFactura>[1], 'comprobante_id' | 'attempt_id'>
  ): Promise<{
    success: boolean;
    cae?: string;
    caeVencimiento?: string;
    numeroComprobante?: string;
    observaciones?: string;
    reconciled?: boolean;
    error?: string;
    pendingReconciliation?: boolean;
    finalizationPending?: boolean;
    alreadyInProgress?: boolean;
    serieOcupada?: boolean;
  }> {
    const correlationId = crypto.randomUUID();

    // La identidad de serie (ambiente/CUIT/punto de venta/tipo de comprobante)
    // se resuelve y valida 100% SERVER-SIDE dentro de la RPC (arca_config +
    // comprobantes.tipo/tipo_comprobante_fiscal) — nunca se envía por parámetro
    // desde acá. Esto es lo que permite bloquear por SERIE FISCAL, no solo por
    // comprobante_id (ver supabase/migrations/20260701150000_arca_atomic_claim.sql).
    const { data: claimData, error: claimError } = await supabase.rpc('claim_comprobante_arca_emission', {
      p_comprobante_id: comprobanteId,
      p_correlation_id: correlationId,
    });

    if (claimError) {
      return { success: false, error: claimError.message || 'Error al reclamar la emisión' };
    }

    const result = claimData?.result as string | undefined;

    if (result === 'already_authorized') {
      // Otra pestaña/proceso ya lo emitió — idempotente, tratamos como éxito.
      return { success: true, cae: claimData?.cae ?? undefined };
    }
    if (result === 'already_in_progress') {
      return { success: false, error: 'La emisión ya está siendo procesada.', alreadyInProgress: true };
    }
    if (result === 'serie_ocupada') {
      // Otro comprobante de la MISMA serie fiscal (ambiente+CUIT+punto de venta+
      // tipo) tiene un intento vivo — nunca se arranca una emisión propia en
      // paralelo para la misma serie (evitaría dos FECAESolicitar con el mismo
      // próximo número).
      return {
        success: false,
        error: 'Ya hay otra emisión en curso para el mismo punto de venta y tipo de comprobante. Esperá a que termine.',
        alreadyInProgress: true,
        serieOcupada: true,
      };
    }
    if (result === 'pending_reconciliation') {
      return {
        success: false,
        error: 'ARCA podría haber recibido una solicitud anterior; estamos verificando antes de continuar.',
        pendingReconciliation: true,
      };
    }
    if (result === 'not_eligible' || result === 'not_found') {
      return { success: false, error: 'El comprobante no es elegible para emitirse en ARCA.' };
    }
    if (result !== 'acquired' || !claimData?.attempt_id) {
      return { success: false, error: 'Resultado inesperado al reclamar la emisión en ARCA.' };
    }

    const arcaResult = await ArcaService.emitirFactura(businessId, {
      ...datosFactura,
      comprobante_id: comprobanteId,
      attempt_id: claimData.attempt_id as string,
    });

    return {
      success: arcaResult.success,
      cae: arcaResult.cae,
      caeVencimiento: arcaResult.caeVencimiento,
      numeroComprobante: arcaResult.numeroComprobante,
      observaciones: arcaResult.observaciones,
      reconciled: arcaResult.reconciled,
      error: arcaResult.error,
      pendingReconciliation: arcaResult.pendingReconciliation,
      finalizationPending: arcaResult.finalizationPending,
    };
  },

  // ── Crear comprobante ───────────────────────────────────────────────────────
  /**
   * Flujo (reordenado — auditoría ARCA fase 3, 2026-07-01):
   *   1. Validar venta y pagos.
   *   2. Generar número local y crear el comprobante YA (estado fiscal pendiente,
   *      cae=null) — recién acá existe un comprobante_id real.
   *   3. Insertar ítems, descontar stock, registrar pagos de caja (no dependen
   *      de ARCA — un fallo de ARCA nunca los revierte).
   *   4. Si es fiscal y se pidió emitir: reclamar atómicamente (_claimYEmitirArca)
   *      y llamar a afip-cae pasando comprobante_id + attempt_id. El resultado
   *      terminal (CAE / rechazo / pendiente de conciliación) lo escribe
   *      afip-cae server-side.
   *   5. Registrar movimientos financieros según el resultado (issued vs draft).
   *   6. Releer el comprobante completo (recoge lo que escribió el paso 4) y
   *      devolver.
   *
   * No emite fiscalmente antes de tener una identidad local persistente
   * (comprobante_id). No reimplementa reglas financieras: solo cambia CUÁNDO
   * se llama a ARCA respecto del insert, preservando exactamente el mismo
   * comportamiento funcional (finanzas/stock/CC) que antes.
   */
  async crear(input: CrearComprobanteInput): Promise<{
    success: boolean;
    comprobante?: Comprobante;
    arcaError?: string;
    error?: string;
    arcaPendingReconciliation?: boolean;
    /** created|existing|already_processing|idempotency_conflict|failed_retryable|failed_final — ver create_comprobante_checkout_atomic. */
    checkoutStatus?: string;
    idempotencyConflict?: boolean;
    alreadyProcessing?: boolean;
  }> {
    const {
      tipo, punto_venta = '0001', condicion_fiscal = 'Consumidor Final',
      customer_id, order_id, observaciones, exchange_rate: globalRate = 1,
      emitir_en_arca = false,
      items, pagos = [], business_id,
      caja_id = null,
      skip_finance_entry = false,
      idempotency_key,
    } = input;

    // La fiscalidad pertenece al tipo canónico, no a flags controlados por el
    // caller. La NC genérica no puede pasar por checkout: necesita factura
    // original + identidad completa y vive exclusivamente en crearNotaCredito.
    const esFiscal = esTipoFiscal(tipo);
    if (tipo === 'nota_credito') {
      return {
        success: false,
        error: 'La Nota de Crédito debe generarse desde el comprobante fiscal original.',
      };
    }
    if (emitir_en_arca && !esFiscal) {
      return {
        success: false,
        error: 'Un comprobante no fiscal no puede emitirse en ARCA.',
      };
    }
    const tipoComprobanteArca = emitir_en_arca ? resolverCbteTipo({ tipo }) : null;
    if (emitir_en_arca && tipoComprobanteArca === null) {
      return { success: false, error: 'El tipo fiscal no tiene un CbteTipo ARCA canónico.' };
    }

    try {
      // ── 1. Calcular totales ──────────────────────────────────────────────
      let subtotalARS = 0, subtotalUSD = 0;
      let costoTotalARS = 0;
      let descuentoTotal = 0;

      for (const item of items) {
        const { baseTotal, subtotalARS: lineARS, rate } = calcularLinea(item, globalRate);
        const disc = Math.min(item.descuento_linea || 0, 100) / 100;
        const rawLine = item.cantidad * item.precio_unitario;
        descuentoTotal += (item.currency || 'ARS') === 'USD'
          ? rawLine * disc * rate
          : rawLine * disc;

        if ((item.currency || 'ARS') === 'USD') {
          subtotalUSD += baseTotal;
          subtotalARS += lineARS;
        } else {
          subtotalARS += baseTotal;
          subtotalUSD += baseTotal / globalRate;
        }

        const costUnit  = item.costo_unitario || 0;
        const costLine  = (item.currency || 'ARS') === 'USD'
          ? costUnit * item.cantidad * (item.exchange_rate || globalRate)
          : costUnit * item.cantidad;
        costoTotalARS += costLine;
      }

      const tax      = tipo === 'factura_a' ? subtotalARS * 0.21 : 0;
      const total    = subtotalARS + tax;
      const totalUSD = subtotalUSD + (tipo === 'factura_a' ? subtotalUSD * 0.21 : 0);

      // Auto-default: si no hay pagos explícitos, cobrar efectivo por el total.
      // Evita que comprobantes nuevos arranquen como "pendiente" sin selección explícita.
      const pagosEffective: ComprobantePago[] =
        pagos.length > 0
          ? pagos
          : [{ payment_method: 'efectivo', amount: total, currency: 'ARS', exchange_rate: globalRate }];

      // Separar pagos reales (caja) de cuenta corriente (deuda en ledger, no caja)
      const pagosCash = pagosEffective.filter(p => p.payment_method !== 'cuenta_corriente');
      const ccTotal   = pagosEffective
        .filter(p => p.payment_method === 'cuenta_corriente')
        .reduce((s, p) => {
          const rate = p.exchange_rate || globalRate;
          return s + (p.currency === 'USD' ? p.amount * rate : p.amount);
        }, 0);

      // Comisiones de pagos (solo pagos reales de caja)
      let totalComisiones = 0;
      const pagosConComision = pagosCash.map(p => {
        const rate    = p.exchange_rate || globalRate;
        const amtARS  = p.currency === 'USD' ? p.amount * rate : p.amount;
        const commRate = p.commission_rate ?? 0;
        const commAmt  = amtARS * commRate;
        totalComisiones += commAmt;
        return { ...p, amtARS, commAmt, netAmt: amtARS - commAmt };
      });

      const totalNeto   = total - totalComisiones;
      const totalBruto  = total;

      const emitirArcaAhora = emitir_en_arca && esFiscal;

      // Validación: Factura A requiere receptor identificado (no Consumidor Final).
      // Se valida ANTES de crear nada — no tiene sentido insertar un comprobante
      // que sabemos que ARCA va a rechazar por este motivo.
      if (emitirArcaAhora && tipo === 'factura_a' && condicionIvaId(condicion_fiscal) === 5) {
        return {
          success: false,
          error: 'Factura A requiere un receptor con CUIT y condición IVA (Responsable Inscripto / Monotributo). No se puede emitir como Consumidor Final.',
        };
      }

      // ── 2-9. Creación local ATÓMICA (comprobante+ítems+stock+pagos+finanzas+CC)
      //      vía create_comprobante_checkout_atomic — UNA transacción
      //      PostgreSQL, protegida por UNIQUE(business_id, idempotency_key)
      //      (auditoría idempotencia checkout, 2026-07-01). Reemplaza los ~8
      //      inserts directos separados que existían antes: dos solicitudes
      //      con la MISMA key nunca producen dos comprobantes/pagos/
      //      descuentos de stock/movimientos financieros — la RPC devuelve
      //      el mismo comprobante_id para ambas. El número local se sigue
      //      generando con generar_numero_comprobante (sin reinventar), y
      //      total_cobrado/saldo_pendiente los sigue calculando el trigger
      //      trig_comprobante_payment_sync existente al insertar los pagos.
      const key = idempotency_key || crypto.randomUUID();

      const pagosPayload = pagosConComision.map(p => ({
        payment_method:    p.payment_method,
        payment_provider:  p.payment_provider || null,
        amount:            p.amount,
        currency:          p.currency,
        amount_ars:        p.amtARS,
        exchange_rate:     p.exchange_rate || globalRate,
        commission_rate:   p.commission_rate || 0,
        commission_amount: p.commAmt,
        net_amount:        p.netAmt,
      }));

      const itemsPayload = items.map((item, idx) => {
        const disc      = Math.min(item.descuento_linea || 0, 100) / 100;
        const lineTotal = item.cantidad * item.precio_unitario * (1 - disc);
        const costUnit  = item.costo_unitario || 0;
        return {
          descripcion:        item.descripcion,
          tipo_linea:         item.tipo_linea || 'producto',
          cantidad:           item.cantidad,
          precio_unitario:    item.precio_unitario,
          descuento_linea:    item.descuento_linea || 0,
          subtotal:           lineTotal,
          costo_unitario:     costUnit,
          costo_total:        costUnit * item.cantidad,
          currency:           item.currency || 'ARS',
          exchange_rate:      item.exchange_rate || globalRate,
          inventory_id:       item.inventory_id || null,
          applied_price_type: item.applied_price_type || null,
          orden:              idx,
        };
      });

      // Hash determinista del contenido comercial — calculado SIEMPRE acá
      // (nunca confiado del caller), para que dos llamadas con el mismo
      // input produzcan siempre el mismo hash.
      const requestHash = await computeCheckoutRequestHash({
        business_id,
        tipo,
        customer_id: customer_id || null,
        condicion_fiscal,
        currency: 'ARS',
        items: itemsPayload,
        pagos: pagosPayload,
        subtotal: subtotalARS,
        tax,
        total,
        cc_total: ccTotal,
      });

      const { data: rpcData, error: rpcError } = await supabase.rpc('create_comprobante_checkout_atomic', {
        p_business_id:     business_id,
        p_idempotency_key: key,
        p_request_hash:    requestHash,
        p_payload: {
          tipo, punto_venta, condicion_fiscal,
          customer_id: customer_id || null,
          order_id: order_id || null,
          observaciones: observaciones || null,
          exchange_rate: globalRate,
          es_fiscal: esFiscal,
          emitir_en_arca,
          caja_id: caja_id || null,
          skip_finance_entry,
          subtotal_ars: subtotalARS,
          tax,
          total,
          total_usd: totalUSD,
          descuento_total: descuentoTotal,
          costo_total_ars: costoTotalARS,
          total_comisiones: totalComisiones,
          total_neto: totalNeto,
          total_bruto: totalBruto,
          cc_total: ccTotal,
          items: itemsPayload,
          pagos: pagosPayload,
        },
      });

      if (rpcError) throw new Error('Error al crear el comprobante: ' + rpcError.message);

      const checkoutStatus = rpcData?.status as string | undefined;

      if (checkoutStatus === 'idempotency_conflict') {
        return {
          success: false,
          error: 'Esta venta fue modificada después de iniciar el cobro. Revisá los datos antes de volver a intentarlo.',
          checkoutStatus,
          idempotencyConflict: true,
        };
      }
      if (checkoutStatus === 'already_processing') {
        return {
          success: false,
          error: 'Estamos confirmando el comprobante. No vuelvas a cobrarlo.',
          checkoutStatus,
          alreadyProcessing: true,
        };
      }
      if (checkoutStatus === 'failed_retryable' || checkoutStatus === 'failed_final') {
        return { success: false, error: rpcData?.error || 'Error al crear el comprobante', checkoutStatus };
      }
      if (checkoutStatus !== 'created' && checkoutStatus !== 'existing') {
        throw new Error('Respuesta inesperada de create_comprobante_checkout_atomic: ' + JSON.stringify(rpcData));
      }

      const compId: string = rpcData.comprobante_id;

      // ── ARCA (si corresponde) — llamado DESPUÉS de que la creación local ya
      //    está confirmada, exactamente igual que antes. NUNCA dentro de la
      //    transacción de la RPC de arriba. Si checkoutStatus === 'existing'
      //    (retry con la misma key), reclamamos igual — _claimYEmitirArca ya
      //    es idempotente por sí solo (already_authorized si ya tiene CAE).
      let arcaError: string | undefined;
      let arcaPendingReconciliation = false;

      if (emitirArcaAhora) {
        const arcaResult = await this._claimYEmitirArca(business_id, compId, {
          tipo_comprobante:         tipoComprobanteArca!,
          tipo_doc_receptor:        99,   // Consumidor Final por defecto (futuro: cargar de cliente)
          nro_doc_receptor:         '0',
          concepto:                 1,
          importe_neto:             subtotalARS,
          importe_iva:              tax,
          alicuota_iva:             tipo === 'factura_a' ? 21 : 0,
          importe_total:            total,
          moneda:                   'PES',
          cotizacion_moneda:        1,
          fecha_cbte:               new Date().toISOString().split('T')[0].replace(/-/g, ''),
          condicion_iva_receptor_id: condicionIvaId(condicion_fiscal),
        });

        if (!arcaResult.success) {
          arcaError = arcaResult.error ?? 'Error desconocido en ARCA';
          arcaPendingReconciliation = !!arcaResult.pendingReconciliation;
        }
      }

      // Releer el comprobante completo — recoge lo que complete_arca_attempt
      // haya escrito server-side (cae, estado_fiscal, etc.) si ARCA autorizó.
      const fullComp = await this.getById(compId, business_id);

      return {
        success: true,
        comprobante: fullComp ?? undefined,
        arcaError,
        arcaPendingReconciliation,
        checkoutStatus,
      };

    } catch (err: any) {
      return { success: false, error: err.message || 'Error desconocido' };
    }
  },

  /**
   * Completa los efectos locales posteriores a una NC ya autorizada por ARCA.
   * Una RPC atómica e idempotente anula el original y deduplica las reversas
   * por la identidad natural de la NC. Se comparte entre la
   * emisión inicial y el retry de una NC que ya obtuvo CAE pero quedó a mitad
   * de esta finalización.
   */
  async _finalizarNotaCreditoAutorizada(
    ncId: string,
  ): Promise<{ success: boolean; error?: string }> {
    // La RPC SECURITY DEFINER hace atómicamente la anulación del original y
    // las reversas FM/BFE. Sus índices naturales permiten repetirla: para la
    // misma NC devuelve replay y nunca deja media finalización aplicada.
    const { data: revData, error: revErr } = await supabase
      .rpc('create_credit_note_finance_reversal', { p_nc_id: ncId })
    const rev = revData as { ok?: boolean; replay?: boolean; error_code?: string; error?: string } | null
    const reversalError = !!revErr || rev?.ok !== true
    if (reversalError) {
      logger.error('FINANCE', 'La reversa financiera de la NC no se registró', {
        ncId, errorCode: rev?.error_code ?? null, transport: revErr?.message ?? null,
      })
    }

    if (reversalError) {
      return {
        success: false,
        error: 'La Nota de Crédito fue autorizada, pero su finalización local quedó pendiente. Reintentá la operación.',
      }
    }
    return { success: true }
  },

  // ── Emitir borrador ──────────────────────────────────────────────────────────
  async emitir(
    comprobanteId: string,
    businessId: string,
    userId: string,
    emitirArcaAhora = false
  ): Promise<{ success: boolean; cae?: string; error?: string; pendingReconciliation?: boolean; finalizationPending?: boolean; alreadyInProgress?: boolean; serieOcupada?: boolean }> {
    const comp = await this.getById(comprobanteId, businessId);
    if (!comp) return { success: false, error: 'Comprobante no encontrado' };

    const tipo = (comp.type || comp.tipo) as TipoComprobante;
    const tipoEsFiscal = esTipoFiscal(tipo);

    // No existe una emisión "local" de un documento fiscal: Factura/NC sin
    // ARCA debe permanecer borrador. Tampoco un remito puede entrar a ARCA.
    if (tipoEsFiscal && !emitirArcaAhora) {
      return { success: false, error: 'Un comprobante fiscal sólo puede emitirse mediante ARCA.' };
    }
    if (!tipoEsFiscal && emitirArcaAhora) {
      return { success: false, error: 'Un comprobante no fiscal no puede emitirse en ARCA.' };
    }

    let tipoComprobanteArca: number | null = null;
    let originalNotaCredito: Comprobante | null = null;
    let identidadOriginalNotaCredito: ReturnType<typeof fiscalIdentity> = null;

    if (tipo === 'nota_credito') {
      if (!comp.comprobante_original_id) {
        return { success: false, error: 'La Nota de Crédito no tiene un comprobante original asociado.' };
      }
      originalNotaCredito = await this.getById(comp.comprobante_original_id, businessId);
      if (!originalNotaCredito) {
        return { success: false, error: 'No se encontró el comprobante fiscal original de la Nota de Crédito.' };
      }

      identidadOriginalNotaCredito = fiscalIdentity(originalNotaCredito);
      const tipoNotaCredito = resolverCbteTipo(comp);
      const tipoFacturaEsperado = tipoNotaCredito === null
        ? null
        : cbteTipoFacturaParaNotaCredito(tipoNotaCredito);
      const tipoNotaCreditoEsperado = identidadOriginalNotaCredito
        ? cbteTipoNotaCreditoParaFactura(identidadOriginalNotaCredito.cbteTipo)
        : null;

      if (
        !identidadOriginalNotaCredito
        || tipoNotaCredito === null
        || tipoFacturaEsperado === null
        || tipoFacturaEsperado !== identidadOriginalNotaCredito.cbteTipo
        || tipoNotaCreditoEsperado !== tipoNotaCredito
      ) {
        return {
          success: false,
          error: 'La Nota de Crédito y su comprobante original no tienen una identidad fiscal A/B/C consistente.',
        };
      }
      tipoComprobanteArca = tipoNotaCredito;
    } else if (tipoEsFiscal) {
      tipoComprobanteArca = resolverCbteTipo(comp);
      if (tipoComprobanteArca === null) {
        return { success: false, error: 'El tipo fiscal no tiene un CbteTipo ARCA canónico.' };
      }
    } else if (tipo !== 'remito') {
      return { success: false, error: 'Tipo de comprobante no soportado para emisión local.' };
    }

    // Atajo rápido (evita un round-trip de RPC): la atomicidad REAL la da
    // claim_comprobante_arca_emission (mismo chequeo, pero atómico en DB) más
    // abajo — este guard en JS por sí solo NO evita carreras entre pestañas.
    if (comp.cae || comp.estado_fiscal === 'emitido') {
      if (tipo === 'nota_credito') {
        const finalizacion = await this._finalizarNotaCreditoAutorizada(
          comprobanteId,
        );
        if (!finalizacion.success) {
          return {
            success: true,
            cae: comp.cae ?? undefined,
            error: finalizacion.error,
            finalizationPending: true,
          };
        }
      }
      return { success: true, cae: comp.cae ?? undefined };
    }
    if (comp.estado === 'anulado' || comp.status === 'cancelled') {
      return { success: false, error: 'El comprobante ya está anulado' };
    }

    // El payload actual (receptor 99/0, IVA 0 y neto=total) sólo es correcto
    // para NC-C. La correspondencia A/B está modelada canónicamente, pero su
    // payload específico todavía no está implementado: fallar antes del claim.
    if (
      tipo === 'nota_credito'
      && (
        tipoComprobanteArca !== CBTE_TIPO.NOTA_CREDITO_C
        || identidadOriginalNotaCredito?.cbteTipo !== CBTE_TIPO.FACTURA_C
      )
    ) {
      return { success: false, error: 'La emisión de Nota de Crédito A/B todavía no está soportada.' };
    }

    if (tipoEsFiscal) {
      try {
        await requireFeature(businessId, 'arca', 'emitir_comprobante_arca')
      } catch (e: any) {
        return { success: false, error: e.message }
      }

      const arcaResult = await this._claimYEmitirArca(businessId, comprobanteId, {
        tipo_comprobante:          tipoComprobanteArca!,
        tipo_doc_receptor:         99,
        nro_doc_receptor:          '0',
        concepto:                  1,
        importe_neto:              comp.subtotal || 0,
        importe_iva:               comp.impuestos || comp.tax || 0,
        alicuota_iva:              tipoComprobanteArca === CBTE_TIPO.FACTURA_A
                                    || tipoComprobanteArca === CBTE_TIPO.NOTA_CREDITO_A ? 21 : 0,
        importe_total:             comp.total || 0,
        condicion_iva_receptor_id: condicionIvaId(comp.condicion_fiscal),
        ...(identidadOriginalNotaCredito ? {
          cbte_asoc_tipo:    identidadOriginalNotaCredito.cbteTipo,
          cbte_asoc_pto_vta: identidadOriginalNotaCredito.puntoVenta,
          cbte_asoc_nro:     identidadOriginalNotaCredito.numero,
        } : {}),
      });

      if (arcaResult.success) {
        // complete_arca_attempt (server-side) ya escribió cae/estado_fiscal=
        // 'emitido'/estado='emitido'/status='issued' — no se reescribe acá.
        if (tipo === 'nota_credito') {
          const finalizacion = await this._finalizarNotaCreditoAutorizada(
            comprobanteId,
          );
          if (!finalizacion.success) {
            return {
              success: true,
              cae: arcaResult.cae,
              error: finalizacion.error,
              finalizationPending: true,
            };
          }
        } else if (comp.items) {
          const stockItems = comp.items
            .filter(i => i.inventory_id && ['producto','repuesto'].includes(i.tipo_linea || 'producto'));
          await this._descontarStock(stockItems, comprobanteId, businessId, userId);
        }
        return { success: true, cae: arcaResult.cae };
      }

      if (arcaResult.alreadyInProgress) {
        return {
          success: false,
          error: arcaResult.error || 'La emisión ya está siendo procesada.',
          alreadyInProgress: true,
          serieOcupada: arcaResult.serieOcupada,
        };
      }
      if (arcaResult.pendingReconciliation) {
        return { success: false, error: arcaResult.error || 'Emisión pendiente de verificación', pendingReconciliation: true };
      }
      return { success: false, error: arcaResult.error || 'Error en ARCA' };
    }

    // Única rama local: remito. El browser no puede cambiar columnas canónicas
    // de comprobantes directamente; la transición mínima vive server-side.
    const { data: issueResult, error: issueError } = await supabase.rpc('issue_remito_atomic', {
      p_comprobante_id: comprobanteId,
      p_business_id: businessId,
    });

    if (issueError) return { success: false, error: issueError.message };
    if (!issueResult?.ok) {
      return { success: false, error: issueResult?.error_code || 'No se pudo emitir el remito' };
    }

    if (comp.items) {
      const stockItems = comp.items
        .filter(i => i.inventory_id && ['producto','repuesto'].includes(i.tipo_linea || 'producto'));
      await this._descontarStock(stockItems, comprobanteId, businessId, userId);
    }

    return { success: true };
  },

  // ── Anular comprobante ────────────────────────────────────────────────────────
  /**
   * Anulación 100% server-side vía RPC `annul_comprobante_atomic` (Etapa 0,
   * migración 20260702120000). Reemplaza la secuencia client-side anterior
   * (reposición manual de stock + update del comprobante + FM/BFE manuales
   * por total_bruto) que no era atómica, caía en la caja de hoy vía trigger
   * y nunca revertía cuenta corriente.
   *
   * La RPC revierte EXACTAMENTE lo registrado (pagos reales, un FM
   * compensatorio por cada FM original, BFE de ingreso/comisiones/COGS,
   * deuda de CC) y repone stock solo si `reponerStock` es true — todo en una
   * transacción, idempotente por `idempotencyKey`.
   *
   * Modos (resueltos acá a partir de `devolverDinero`):
   *  - refund_current_session: hubo cobros y se devuelve el dinero → egreso
   *    en la caja abierta actual (la sesión original, abierta o cerrada, no
   *    se modifica jamás).
   *  - commercial_annulment: no hubo cobros (venta CC/pendiente) → revierte
   *    deuda/COGS/stock sin movimiento de caja.
   *  (void_same_session existe en la RPC para uso programático/tests; la UI
   *   usa refund, que cubre el caso misma-caja con idéntico efecto neto.)
   */
  async anular(
    comprobanteId: string,
    businessId: string,
    _userId: string,
    motivo?: string,
    opts?: {
      /** ¿Se le devolvió el dinero al cliente? (aplica solo si hubo cobros) */
      devolverDinero?: boolean;
      /** ¿La mercadería volvió físicamente al stock? (default true) */
      reponerStock?: boolean;
      /** Clave estable ante reintentos (default: una por llamada) */
      idempotencyKey?: string;
    }
  ): Promise<{ success: boolean; error?: string; errorCode?: string; replay?: boolean; requiereNotaCredito?: boolean }> {
    const motivoFinal = (motivo || '').trim();
    if (!motivoFinal) {
      return { success: false, error: 'El motivo de la anulación es obligatorio' };
    }

    // Solo para decidir el modo por defecto — la validación real (estado,
    // CAE, cobros, concurrencia) vive en la RPC con el comprobante bloqueado.
    const comp = await this.getById(comprobanteId, businessId);
    if (!comp) return { success: false, error: 'Comprobante no encontrado' };

    const cobrado = comp.total_cobrado ?? 0;
    const devolverDinero = opts?.devolverDinero ?? cobrado > 0;
    const mode = devolverDinero && cobrado > 0 ? 'refund_current_session' : 'commercial_annulment';

    const { data, error } = await supabase.rpc('annul_comprobante_atomic', {
      p_comprobante_id:  comprobanteId,
      p_mode:            mode,
      p_motivo:          motivoFinal,
      p_restore_stock:   opts?.reponerStock ?? true,
      p_idempotency_key: opts?.idempotencyKey || crypto.randomUUID(),
    });

    if (error) return { success: false, error: error.message };

    const result = data as {
      ok: boolean;
      error?: string;
      error_code?: string;
      message?: string;
      replay?: boolean;
      requiere_nota_credito?: boolean;
    } | null;

    if (!result?.ok) {
      // M7 7D.3 — `error_code` se propaga tal cual (ALREADY_ANNULLED,
      // IDEMPOTENCY_CONFLICT, PERIOD_CLOSED, AUDIT_FAILED…) para que la UI
      // decida con un código y no parseando texto. `error` se conserva por
      // compatibilidad con los llamadores que aún lo leen.
      return {
        success: false,
        errorCode: result?.error_code,
        error: result?.message || result?.error || 'Error al anular el comprobante',
        requiereNotaCredito: result?.requiere_nota_credito === true,
      };
    }

    // `replay` distingue "recién anulado" de "esta key ya se había ejecutado".
    return { success: true, replay: result?.replay === true };
  },

  // ── Actualizar medio/estado de cobro ──────────────────────────────────────────
  /**
   * Modifica el pago de un comprobante ya creado.
   * - Si existen comprobante_payments: hace UPDATE (la sync trigger recalcula estado_comercial).
   * - Si no existen: inserta uno nuevo (la finance trigger crea el movimiento de caja).
   * - Actualiza el metodo_pago del financial_movements vinculado.
   * NO toca datos fiscales (CAE, número, tipo, items).
   */
  async actualizarPago(
    comprobanteId: string,
    businessId: string,
    userId: string,
    params: {
      payment_method: MedioPago;
      amount: number;
      currency?: 'ARS' | 'USD';
      exchange_rate?: number;
      notes?: string;
      commission_amount?: number;
      payment_provider?: string;
      /**
       * M7 7D.1: OBLIGATORIA. Antes era opcional y se mandaba `?? null`: un
       * caller que se olvidaba de pasarla dejaba a la RPC sin registro de
       * idempotencia (el bloque `IF v_key IS NOT NULL` se saltea entero) y la
       * operación quedaba SIN replay posible ante una respuesta perdida — en
       * silencio. Ahora es un error de compilación.
       *
       * La key representa la INTENCIÓN "reemplazar el cobro de este comprobante
       * por este": la crea y la rota el flujo de UI, no este servicio.
       */
      idempotencyKey: string;
    }
  ): Promise<{ success: boolean; error?: string; errorCode?: string; conflict?: boolean }> {
    const rate   = params.exchange_rate || 1;
    const amtARS = (params.currency || 'ARS') === 'USD' ? params.amount * rate : params.amount;

    // RPC atómica replace_comprobante_payment (M6): compensa append-only los
    // FM/BFE del pago anterior (incluida la COMISIÓN → sin huérfanas), nunca toca
    // caja cerrada, y crea el nuevo pago (con su comisión) una sola vez. Idempotente.
    const { data, error } = await supabase.rpc('replace_comprobante_payment', {
      p_comprobante_id:   comprobanteId,
      p_business_id:      businessId,
      p_payment_method:   params.payment_method,
      p_amount:           params.amount,
      p_amount_ars:       amtARS,
      p_currency:         params.currency || 'ARS',
      p_exchange_rate:    rate,
      p_notes:            params.notes || null,
      p_user_id:          userId,
      p_commission_amount: params.commission_amount ?? 0,
      p_payment_provider:  params.payment_provider ?? null,
      p_idempotency_key:   params.idempotencyKey,
    });

    // Error de transporte (red/timeout): NO se sabe si el server lo aplicó. El
    // caller debe conservar la key y permitir retry con el mismo payload.
    if (error) return { success: false, error: error.message };

    const result = data as { ok: boolean; error?: string; error_code?: string; message?: string } | null;
    if (result?.error === 'IDEMPOTENCY_CONFLICT') {
      return { success: false, conflict: true, errorCode: 'IDEMPOTENCY_CONFLICT',
        error: result.message || 'La solicitud ya fue utilizada con datos diferentes.' };
    }
    // error_code se propaga tal cual (PAYMENT_SET_CHANGED, PERIOD_CLOSED,
    // ALREADY_ANNULLED, AUDIT_FAILED…) para que la UI decida el lifecycle de la
    // key sin reinterpretar el mensaje.
    if (!result?.ok) {
      return { success: false, errorCode: result?.error_code,
        error: result?.error || 'Error al actualizar cobro' };
    }

    return { success: true };
  },

  // ── Crear Nota de Crédito para comprobante emitido en ARCA ───────────────────
  /**
   * Flujo completo:
   * 1. Llama RPC create_credit_note_from_comprobante (crea borrador + copia ítems)
   * 2. Si emitirEnArca=true: llama afip-cae con CbtesAsoc → guarda CAE en NC
   * 3. Actualiza original a estado_fiscal='anulado_fiscal'
   * 4. Crea entrada negativa en business_finance_entries (reversa de caja)
   */
  async crearNotaCredito(params: {
    originalComprobanteId: string
    businessId: string
    userId: string
    emitirEnArca?: boolean
    motivo?: string
  }): Promise<{
    success: boolean
    nc?: Comprobante
    cae?: string
    arca_error?: string
    error?: string
    pendingReconciliation?: boolean
  }> {
    // ── 0. Identidad fiscal del original — FAIL-CLOSED antes de crear nada ───
    // El CbtesAsoc que se manda a AFIP referencia al comprobante original por
    // punto de venta + número. Ese dato sólo puede salir de `numero_fiscal`, que
    // es lo que AFIP autorizó. El código anterior caía a `original.punto_venta`
    // (el PV LOCAL) cuando faltaba: con sales_points.numero=7 y
    // arca_config.punto_venta=3 eso mandaba a AFIP un CbtesAsoc apuntando al PV
    // 7, que allá no existe.
    //
    // Se valida la terna completa ANTES de crear el borrador para no dejar una
    // NC huérfana, incluso cuando el caller pide crearla sin emitirla todavía.
    const original = await this.getById(params.originalComprobanteId, params.businessId)
    if (!original) {
      return { success: false, error: 'Comprobante original no encontrado' }
    }
    const identidadOriginal = fiscalIdentity(original)
    const ncTipoEsperado = identidadOriginal
      ? cbteTipoNotaCreditoParaFactura(identidadOriginal.cbteTipo)
      : null
    if (!identidadOriginal || ncTipoEsperado === null) {
      return {
        success: false,
        error: 'El comprobante original no tiene una identidad fiscal A/B/C completa en ARCA '
             + '(punto de venta, tipo y número). Emitilo o reconciliá su CAE antes de generar la Nota de Crédito.',
      }
    }
    if (
      identidadOriginal.cbteTipo !== CBTE_TIPO.FACTURA_C
      || ncTipoEsperado !== CBTE_TIPO.NOTA_CREDITO_C
    ) {
      return {
        success: false,
        error: 'La emisión de Nota de Crédito A/B todavía no está soportada; sólo puede generarse NC-C.',
      }
    }
    // ── 1. Crear draft NC + copiar ítems (RPC atómica) ───────────────────────
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      'create_credit_note_from_comprobante',
      { p_comprobante_id: params.originalComprobanteId }
    )
    if (rpcError) return { success: false, error: rpcError.message }
    if (!rpcData?.success) return { success: false, error: rpcData?.error || 'Error al crear NC' }

    const ncId:          string = rpcData.nc_id
    const ncTipoFiscal:  number = rpcData.nc_tipo_fiscal
    const originalNumero: string = rpcData.original_numero || params.originalComprobanteId.slice(0, 8)

    if (ncTipoFiscal !== ncTipoEsperado) {
      return {
        success: false,
        error: 'La Nota de Crédito creada no corresponde a la clase fiscal A/B/C del comprobante original.',
      }
    }

    let cae: string | undefined
    let arcaError: string | undefined
    let pendingReconciliation = false

    // Las observaciones descriptivas no las escribe complete_arca_attempt.
    await supabase.from('comprobantes')
      .update({
        observaciones: `Nota de Crédito — anula ${originalNumero}${params.motivo ? ` · ${params.motivo}` : ''}`,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', ncId)
      .eq('business_id', params.businessId)

    // ── 2. Emisión opcional por la ruta ÚNICA ───────────────────────────────
    // emitir() resuelve otra vez la identidad, arma CbtesAsoc, reclama ARCA y
    // ejecuta la finalización idempotente. crearNotaCredito no duplica ese flujo.
    if (params.emitirEnArca) {
      const emision = await this.emitir(ncId, params.businessId, params.userId, true)
      cae = emision.cae
      if (!emision.success || emision.finalizationPending) arcaError = emision.error
      pendingReconciliation = emision.pendingReconciliation === true
    }

    const nc = await this.getById(ncId, params.businessId)
    return { success: true, nc: nc ?? undefined, cae, arca_error: arcaError, pendingReconciliation }
  },

  // ── Eliminar comprobante local (no fiscal) ────────────────────────────────────
  // Llama la RPC atómica que elimina el comprobante junto con todos sus
  // registros financieros asociados (payments, financial_movements, BFE).
  // Bloquea si el comprobante ya fue emitido en ARCA (devuelve arca_blocked=true).
  async eliminar(
    comprobanteId: string,
    _businessId: string
  ): Promise<{ success: boolean; arca_blocked?: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('delete_comprobante_with_finance', {
      p_comprobante_id: comprobanteId,
    });
    if (error) return { success: false, error: error.message };
    if (!data?.success) {
      return {
        success:      false,
        arca_blocked: data?.arca_blocked === true,
        error:        data?.error || 'Error al eliminar el comprobante',
      };
    }
    return { success: true };
  },

  // ── Calculadora de cobro ──────────────────────────────────────────────────────
  calcularCobro(params: {
    totalBase: number;
    modoNeto?: boolean;
    netoDeseado?: number;
    commissionRate: number;
    cargoFijo?: number;
  }) {
    const { totalBase, modoNeto = false, netoDeseado = 0, commissionRate, cargoFijo = 0 } = params;

    if (modoNeto && netoDeseado > 0) {
      const montoACobrar = (netoDeseado + cargoFijo) / (1 - commissionRate);
      const comision     = montoACobrar * commissionRate + cargoFijo;
      return {
        montoACobrar,
        comision,
        netoEsperado:   netoDeseado,
        saldoPendiente: 0,
      };
    }

    const comision     = totalBase * commissionRate + cargoFijo;
    const netoEsperado = totalBase - comision;
    return {
      montoACobrar:   totalBase,
      comision,
      netoEsperado,
      saldoPendiente: 0,
    };
  },

  // ── Internos ──────────────────────────────────────────────────────────────────

  async _descontarStock(
    items: { id?: string; inventory_id?: string | null; cantidad: number; tipo_linea?: string }[],
    comprobanteId: string,
    businessId: string,
    userId?: string
  ) {
    for (const item of items) {
      if (!item.inventory_id) continue;
      if (!['producto', 'repuesto', undefined, null].includes(item.tipo_linea as any)) continue;

      // ── Idempotencia: buscar el comprobante_item para verificar si ya fue procesado ──
      const { data: ciRow } = await supabase
        .from('comprobante_items')
        .select('id, stock_processed')
        .eq('comprobante_id', comprobanteId)
        .eq('inventory_id', item.inventory_id)
        .maybeSingle();

      if (ciRow?.stock_processed === true) continue; // Ya descontado, saltar

      const { data: inv } = await supabase
        .from('inventory')
        .select('stock_quantity')
        .eq('id', item.inventory_id)
        .eq('business_id', businessId)
        .single();

      if (!inv) continue;

      const prevStock = inv.stock_quantity ?? 0;
      const newStock  = prevStock - item.cantidad;

      await supabase.from('inventory')
        .update({ stock_quantity: Math.max(0, newStock), updated_at: new Date().toISOString() })
        .eq('id', item.inventory_id)
        .eq('business_id', businessId);

      const { data: mov } = await supabase.from('inventory_movements').insert({
        business_id:       businessId,
        inventory_item_id: item.inventory_id,
        movement_type:     'sale',
        quantity:          -item.cantidad,
        previous_stock:    prevStock,
        new_stock:         Math.max(0, newStock),
        reference_type:    'comprobante',
        reference_id:      comprobanteId,
        note:              'Salida por venta en comprobante',
        created_by:        userId || null,
      }).select('id').maybeSingle();

      // Marcar item como procesado para evitar doble descuento
      if (ciRow?.id) {
        await supabase.from('comprobante_items')
          .update({
            stock_processed:    true,
            stock_processed_at: new Date().toISOString(),
            stock_movement_id:  mov?.id ?? null,
          })
          .eq('id', ciRow.id);
      }
    }
  },

  // La reposición de stock por anulación vive dentro de la RPC
  // annul_comprobante_atomic (server-side, FOR UPDATE + marcador
  // stock_processed = exactamente una vez) — Etapa 0.
};

export default comprobanteService;
