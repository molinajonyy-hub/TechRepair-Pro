import { supabase } from '../lib/supabase';
import ArcaService from './arcaService';
import { cuentasService } from './cuentasService';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TipoComprobante = 'remito' | 'factura_a' | 'factura_c' | 'nota_credito';
export type TipoLinea       = 'producto' | 'servicio' | 'repuesto' | 'otro';
export type EstadoComercial = 'pendiente' | 'parcial' | 'pagado' | 'anulado';
export type EstadoFiscal    = 'no_fiscal' | 'pendiente_emision' | 'emitido' | 'error_emision' | 'anulado_fiscal';
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

// Tipo AFIP code map
const AFIP_TIPO_CODE: Partial<Record<TipoComprobante, number>> = {
  factura_a:    1,
  factura_b:    6,
  factura_c:    11,
  nota_credito: 3,
};

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

  // ── Crear comprobante ───────────────────────────────────────────────────────
  /**
   * Flujo:
   * - Remito / no fiscal: guarda directamente como 'issued'
   * - Fiscal + emitir_en_arca=true:
   *     1. Llama ARCA
   *     2. Si OK → guarda con CAE y estado_fiscal='emitido'
   *     3. Si error → guarda como borrador con estado_fiscal='error_emision'
   * - Fiscal + emitir_en_arca=false: guarda como borrador
   */
  async crear(input: CrearComprobanteInput): Promise<{
    success: boolean;
    comprobante?: Comprobante;
    arcaError?: string;
    error?: string;
  }> {
    const {
      tipo, punto_venta = '0001', condicion_fiscal = 'Consumidor Final',
      customer_id, order_id, observaciones, exchange_rate: globalRate = 1,
      es_fiscal = false, emitir_en_arca = false,
      items, pagos = [], business_id, created_by,
      caja_id = null,
      skip_finance_entry = false,
    } = input;

    const esFiscal = es_fiscal || emitir_en_arca;

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

      // Separar pagos reales (caja) de cuenta corriente (deuda en ledger, no caja)
      const pagosCash = pagos.filter(p => p.payment_method !== 'cuenta_corriente');
      const ccTotal   = pagos
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

      // ── 2. Si es fiscal y emitir_en_arca, llamar ARCA PRIMERO ───────────
      let cae: string | null = null;
      let caeVencimiento: string | null = null;
      let numeroFiscal: string | null = null;
      let estadoFiscal: EstadoFiscal = esFiscal ? 'pendiente_emision' : 'no_fiscal';
      let arcaError: string | undefined;
      let arcaResponse: any = null;

      if (emitir_en_arca && esFiscal && AFIP_TIPO_CODE[tipo] !== undefined) {
        try {
          const arcaResult = await ArcaService.emitirFactura(business_id, {
            tipo_comprobante:  AFIP_TIPO_CODE[tipo]!,
            tipo_doc_receptor: 99,   // Consumidor final por defecto
            nro_doc_receptor:  '0',
            concepto:          1,
            importe_neto:      subtotalARS,
            importe_iva:       tax,
            alicuota_iva:      tipo === 'factura_a' ? 21 : 0,
            importe_total:     total,
            moneda:            'PES',
            cotizacion_moneda: 1,
            fecha_cbte:        new Date().toISOString().split('T')[0].replace(/-/g, ''),
          });

          if (arcaResult.success) {
            cae            = arcaResult.cae ?? null;
            caeVencimiento = arcaResult.caeVencimiento ?? null;
            numeroFiscal   = arcaResult.numeroComprobante ?? null;
            estadoFiscal   = 'emitido';
            arcaResponse   = arcaResult;
          } else {
            estadoFiscal = 'error_emision';
            arcaError    = arcaResult.error ?? 'Error desconocido en ARCA';
            arcaResponse = arcaResult;
          }
        } catch (e: any) {
          estadoFiscal = 'error_emision';
          arcaError    = e?.message ?? 'Error al conectar con ARCA';
          arcaResponse = { error: arcaError };
        }
      }

      // Si ARCA falló y el usuario quería emitir, guardar como borrador
      const estadoDefinitivo: string = estadoFiscal === 'emitido'
        ? 'issued'
        : (emitir_en_arca && arcaError)
          ? 'draft'
          : (esFiscal ? 'draft' : 'issued');

      // ── 3. Generar número de comprobante ────────────────────────────────
      const numero = await this.generarNumero(tipo, business_id, punto_venta);

      // ── 4. Insertar comprobante ─────────────────────────────────────────
      const compData: Record<string, any> = {
        business_id,
        created_by:       created_by || null,
        customer_id:      customer_id || null,
        order_id:         order_id || null,
        tipo,
        type:             tipo,
        punto_venta,
        numero,
        number:           numero,
        fecha:            new Date().toISOString(),
        date:             new Date().toISOString(),
        condicion_fiscal,
        observaciones:    observaciones || null,
        currency:         'ARS',
        exchange_rate:    globalRate,
        subtotal:         subtotalARS,
        impuestos:        tax,
        tax,
        total:            total,
        total_ars:        total,
        total_usd:        totalUSD,
        descuento_total:  descuentoTotal,
        recargo_total:    0,
        total_bruto:      totalBruto,
        total_cobrado:    pagosCash.length > 0 ? pagosConComision.reduce((s, p) => s + p.amtARS, 0) : 0,
        saldo_pendiente:  Math.max(0, totalBruto - (pagosCash.length > 0 ? pagosConComision.reduce((s, p) => s + p.amtARS, 0) : 0)),
        total_comisiones: totalComisiones,
        total_neto:       totalNeto,
        estado:           estadoDefinitivo === 'issued' ? 'emitido' : 'borrador',
        status:           estadoDefinitivo,
        estado_comercial: (() => {
          const cashCobrado = pagosConComision.reduce((s, p) => s + p.amtARS, 0);
          if (cashCobrado >= totalBruto - 1) return 'pagado';
          if (cashCobrado > 0 || ccTotal > 0) return 'parcial';
          return 'pendiente';
        })(),
        estado_fiscal:    estadoFiscal,
        es_fiscal:        esFiscal,
        emitir_en_arca,
        cae,
        cae_vencimiento:  caeVencimiento,
        numero_fiscal:    numeroFiscal,
        afip_response:    arcaResponse,
      };

      const { data: comp, error: compErr } = await supabase
        .from('comprobantes')
        .insert(compData)
        .select()
        .single();

      if (compErr || !comp) throw new Error(compErr?.message || 'Error al crear comprobante');

      // ── 5. Insertar ítems ────────────────────────────────────────────────
      const itemsToInsert = items.map((item, idx) => {
        const disc      = Math.min(item.descuento_linea || 0, 100) / 100;
        const qty       = item.cantidad;
        const price     = item.precio_unitario;
        const lineTotal = qty * price * (1 - disc);
        const costUnit  = item.costo_unitario || 0;
        return {
          comprobante_id:  comp.id,
          business_id,
          created_by:      created_by || null,
          descripcion:     item.descripcion,
          tipo_linea:      item.tipo_linea || 'producto',
          cantidad:        qty,
          precio_unitario: price,
          descuento_linea: item.descuento_linea || 0,
          subtotal:        lineTotal,
          costo_unitario:  costUnit,
          costo_total:     costUnit * qty,
          currency:        item.currency || 'ARS',
          exchange_rate:       item.exchange_rate || globalRate,
          inventory_id:        item.inventory_id || null,
          applied_price_type:  item.applied_price_type || null,
          orden:               idx,
        };
      });

      const { error: itemsErr } = await supabase
        .from('comprobante_items')
        .insert(itemsToInsert);

      if (itemsErr) throw new Error('Error al crear ítems: ' + itemsErr.message);

      // ── 6. Descontar stock para ítems de producto/repuesto ──────────────
      // El stock se descuenta siempre que se confirma una venta comercial,
      // sin importar si está emitida fiscalmente en ARCA o no.
      // La idempotencia (stock_processed) previene doble descuento.
      await this._descontarStock(itemsToInsert, comp.id, business_id, created_by);

      // ── 7. Registrar pagos de caja (NO cuenta corriente) ────────────────
      if (pagosCash.length > 0) {
        const pagosToInsert = pagosConComision.map(p => ({
          comprobante_id:    comp.id,
          business_id,
          amount:            p.amount,
          currency:          p.currency,
          amount_ars:        p.amtARS,
          exchange_rate:     p.exchange_rate || globalRate,
          payment_method:    p.payment_method,
          payment_provider:  p.payment_provider || null,
          commission_rate:   p.commission_rate || 0,
          commission_amount: p.commAmt,
          net_amount:        p.netAmt,
          date:              new Date().toISOString().split('T')[0],
          created_by:        created_by || null,
        }));

        const { error: pagErr } = await supabase
          .from('comprobante_payments')
          .insert(pagosToInsert);

        if (pagErr) console.warn('Error al registrar pagos:', pagErr.message);
      }

      // ── 8. Registrar costo de productos en finanzas ──────────────────────
      if (estadoDefinitivo === 'issued' && costoTotalARS > 0 && !skip_finance_entry) {
        await supabase.from('business_finance_entries').insert({
          business_id,
          date:        new Date().toISOString().split('T')[0],
          type:        'variable_cost',
          category:    'mercaderia',
          description: `Costo de productos · Comprobante #${numero}`,
          amount:      costoTotalARS,
          currency:    'ARS',
          amount_ars:  costoTotalARS,
          exchange_rate: 1,
          created_by:  created_by || null,
        });
      }

      // ── 9. Registrar ingreso en finanzas (solo si no hay pagos de caja ni CC; con pagos de caja lo maneja el trigger)
      if (estadoDefinitivo === 'issued' && !skip_finance_entry && pagosCash.length === 0 && ccTotal === 0) {
        const today = new Date().toISOString().split('T')[0];
        const desc  = `Comprobante #${numero}`;

        await supabase.from('business_finance_entries').insert({
          business_id,
          date:        today,
          type:        'income',
          category:    'ventas_productos',
          description: desc,
          amount:      total,
          currency:    'ARS',
          amount_ars:  total,
          exchange_rate: globalRate,
          created_by:  created_by || null,
        });

        await supabase.from('financial_movements').insert({
          business_id,
          date:        today,
          type:        'income',
          currency:    'ARS',
          amount:      total,
          amount_ars:  total,
          exchange_rate: globalRate,
          source:      'comprobante',
          description: desc,
          created_by:  created_by || null,
          caja_id:     caja_id || null,
        });
      }

      // ── 10. Cuenta corriente: registrar deuda si hay saldo sin efectivo ───
      if (estadoDefinitivo === 'issued' && ccTotal > 0 && customer_id) {
        try {
          const { data: custData } = await supabase
            .from('customers').select('name, phone').eq('id', customer_id).maybeSingle();
          const account = await cuentasService.getOrCreate(
            business_id, 'cliente', customer_id,
            (custData as any)?.name || 'Cliente',
            (custData as any)?.phone || null,
          );
          await cuentasService.registerSale(
            business_id, account.id,
            totalBruto,
            totalBruto - ccTotal,
            `Comprobante #${numero}`,
            comp.id,
            created_by,
          );
        } catch (e: any) {
          console.warn('[comprobanteService] CC account movement failed:', e.message);
        }
      }

      const fullComp = await this.getById(comp.id, business_id);

      return {
        success: true,
        comprobante: fullComp || (comp as Comprobante),
        arcaError,
      };

    } catch (err: any) {
      return { success: false, error: err.message || 'Error desconocido' };
    }
  },

  // ── Emitir borrador ──────────────────────────────────────────────────────────
  async emitir(
    comprobanteId: string,
    businessId: string,
    userId: string,
    emitirArcaAhora = false
  ): Promise<{ success: boolean; cae?: string; error?: string }> {
    const comp = await this.getById(comprobanteId, businessId);
    if (!comp) return { success: false, error: 'Comprobante no encontrado' };

    let cae: string | null = null;
    let estadoFiscal: EstadoFiscal = 'no_fiscal';
    let arcaResponse: any = null;

    const tipo = (comp.type || comp.tipo) as TipoComprobante;

    if (emitirArcaAhora && AFIP_TIPO_CODE[tipo] !== undefined) {
      try {
        const arcaResult = await ArcaService.emitirFactura(businessId, {
          tipo_comprobante:  AFIP_TIPO_CODE[tipo]!,
          tipo_doc_receptor: 99,
          nro_doc_receptor:  '0',
          concepto:          1,
          importe_neto:      comp.subtotal || 0,
          importe_iva:       comp.impuestos || comp.tax || 0,
          alicuota_iva:      tipo === 'factura_a' ? 21 : 0,
          importe_total:     comp.total || 0,
        });

        if (arcaResult.success) {
          cae          = arcaResult.cae ?? null;
          estadoFiscal = 'emitido';
          arcaResponse = arcaResult;
        } else {
          estadoFiscal = 'error_emision';
          arcaResponse = arcaResult;
          return { success: false, error: arcaResult.error || 'Error en ARCA' };
        }
      } catch (e: any) {
        return { success: false, error: e.message || 'Error ARCA' };
      }
    } else {
      estadoFiscal = 'no_fiscal';
    }

    const { error } = await supabase
      .from('comprobantes')
      .update({
        estado:        'emitido',
        status:        'issued',
        estado_fiscal: estadoFiscal,
        cae,
        afip_response: arcaResponse,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', comprobanteId)
      .eq('business_id', businessId);

    if (error) return { success: false, error: error.message };

    // Descontar stock al emitir
    if (comp.items) {
      const stockItems = comp.items
        .filter(i => i.inventory_id && ['producto','repuesto'].includes(i.tipo_linea || 'producto'));
      await this._descontarStock(stockItems, comprobanteId, businessId, userId);
    }

    return { success: true, cae: cae || undefined };
  },

  // ── Anular comprobante ────────────────────────────────────────────────────────
  async anular(
    comprobanteId: string,
    businessId: string,
    userId: string,
    motivo?: string
  ): Promise<{ success: boolean; error?: string }> {
    const comp = await this.getById(comprobanteId, businessId);
    if (!comp) return { success: false, error: 'Comprobante no encontrado' };

    const currentStatus = comp.status || comp.estado;
    if (['cancelled', 'anulado'].includes(currentStatus || '')) {
      return { success: false, error: 'El comprobante ya está anulado' };
    }

    // Revertir stock
    if (comp.items) {
      await this._revertirStock(
        comp.items.filter(i => i.inventory_id && ['producto','repuesto'].includes(i.tipo_linea || 'producto')),
        comprobanteId,
        businessId,
        userId
      );
    }

    const { error } = await supabase
      .from('comprobantes')
      .update({
        estado:          'anulado',
        status:          'cancelled',
        estado_comercial:'anulado',
        estado_fiscal:   'anulado_fiscal',
        afip_response:   { ...(comp.afip_response || {}), anulacion: { motivo, fecha: new Date().toISOString() } },
        updated_at:      new Date().toISOString(),
      })
      .eq('id', comprobanteId)
      .eq('business_id', businessId);

    if (error) return { success: false, error: error.message };

    // Reverso en finanzas (trigger también lo hace, esto es backup)
    const numero = comp.number || comp.numero || comprobanteId.slice(0, 8);
    await supabase.from('business_finance_entries').insert({
      business_id:              businessId,
      date:                     new Date().toISOString().split('T')[0],
      type:                     'income',
      category:                 'ventas_productos',
      description:              `ANULACIÓN Comprobante #${numero}` + (motivo ? ` — ${motivo}` : ''),
      amount:                   -(comp.total_bruto || comp.total || 0),
      currency:                 'ARS',
      amount_ars:               -(comp.total_bruto || comp.total || 0),
      exchange_rate:            comp.exchange_rate || 1,
      reference_comprobante_id: comprobanteId,
      source:                   'comprobante',
      created_by:               userId,
    });

    return { success: true };
  },

  // ── Registrar pago sobre comprobante ──────────────────────────────────────────
  async registrarPago(
    comprobanteId: string,
    businessId: string,
    userId: string,
    pago: ComprobantePago,
    globalRate = 1
  ): Promise<{ success: boolean; error?: string }> {
    const amtARS      = pago.currency === 'USD' ? pago.amount * (pago.exchange_rate || globalRate) : pago.amount;
    const commRate    = pago.commission_rate ?? 0;
    const commAmt     = amtARS * commRate;
    const netAmt      = amtARS - commAmt;

    const { error } = await supabase.from('comprobante_payments').insert({
      comprobante_id:    comprobanteId,
      business_id:       businessId,
      amount:            pago.amount,
      currency:          pago.currency,
      amount_ars:        amtARS,
      exchange_rate:     pago.exchange_rate || globalRate,
      payment_method:    pago.payment_method,
      payment_provider:  pago.payment_provider || null,
      commission_rate:   commRate,
      commission_amount: commAmt,
      net_amount:        netAmt,
      date:              new Date().toISOString().split('T')[0],
      created_by:        userId,
    });

    return error ? { success: false, error: error.message } : { success: true };
  },

  // ── Eliminar borrador ─────────────────────────────────────────────────────────
  async eliminar(comprobanteId: string, businessId: string): Promise<{ success: boolean; error?: string }> {
    await supabase.from('comprobante_items').delete().eq('comprobante_id', comprobanteId);
    const { error } = await supabase.from('comprobantes').delete()
      .eq('id', comprobanteId).eq('business_id', businessId);
    return error ? { success: false, error: error.message } : { success: true };
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

  async _revertirStock(
    items: { id?: string; inventory_id?: string | null; cantidad: number }[],
    comprobanteId: string,
    businessId: string,
    userId?: string
  ) {
    for (const item of items) {
      if (!item.inventory_id) continue;

      // Idempotencia: solo revertir si el item tiene stock_processed = true
      if (item.id) {
        const { data: ciRow } = await supabase
          .from('comprobante_items')
          .select('stock_processed')
          .eq('id', item.id)
          .maybeSingle();
        if (!ciRow?.stock_processed) continue; // Nunca fue descontado, nada que revertir
      }

      const { data: inv } = await supabase
        .from('inventory')
        .select('stock_quantity')
        .eq('id', item.inventory_id)
        .eq('business_id', businessId)
        .single();

      if (!inv) continue;

      const prevStock = inv.stock_quantity ?? 0;
      const newStock  = prevStock + item.cantidad;

      await supabase.from('inventory')
        .update({ stock_quantity: newStock, updated_at: new Date().toISOString() })
        .eq('id', item.inventory_id)
        .eq('business_id', businessId);

      await supabase.from('inventory_movements').insert({
        business_id:       businessId,
        inventory_item_id: item.inventory_id,
        movement_type:     'return',
        quantity:          item.cantidad,
        previous_stock:    prevStock,
        new_stock:         newStock,
        reference_type:    'comprobante',
        reference_id:      comprobanteId,
        note:              'Devolución por anulación de comprobante',
        created_by:        userId || null,
      });

      // Desmarcar item
      if (item.id) {
        await supabase.from('comprobante_items')
          .update({ stock_processed: false, stock_processed_at: null, stock_movement_id: null })
          .eq('id', item.id);
      }
    }
  },
};

export default comprobanteService;
