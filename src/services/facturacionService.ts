import { supabase } from '../lib/supabase';
import { resolverCbteTipo } from '../lib/fiscalIdentity';

// ============================================
// TIPOS DE COMPROBANTES
// ============================================
export type TipoComprobante = 'remito' | 'factura_a' | 'factura_c' | 'nota_credito';

export interface Comprobante {
  id: string;
  order_id: string | null;
  customer_id: string | null;
  business_id: string | null;
  tipo: TipoComprobante;
  numero: string | null;
  punto_venta: string;
  fecha: string;
  subtotal: number;
  impuestos: number;
  total: number;
  currency: 'ARS' | 'USD';
  total_ars: number;
  total_usd: number;
  exchange_rate: number;
  estado: 'borrador' | 'emitido' | 'anulado';
  estado_fiscal?: string | null;
  numero_fiscal?: string | null;
  cae: string | null;
  cae_vencimiento: string | null;
  afip_response: any;
  condicion_fiscal: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComprobanteItem {
  id: string;
  comprobante_id: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  currency: 'ARS' | 'USD';
  exchange_rate: number;
  inventory_id?: string | null;
  orden: number;
}

export interface CrearComprobanteDTO {
  order_id: string;
  customer_id: string;
  tipo: TipoComprobante;
  punto_venta?: string;
  condicion_fiscal?: string;
  business_id: string;
  created_by?: string;
  items: {
    descripcion: string;
    cantidad: number;
    precio_unitario: number;
    inventory_id?: string;
  }[];
}

// ============================================
// ⚠️ SERVICIO LEGACY BLOQUEADO (auditoría ARCA 2026-07-01)
//
// Este objeto simulaba AFIP/ARCA con un CAE aleatorio y estado "emitido" sin
// llamar nunca al servicio real — fue la causa raíz de que "reintentar emisión"
// desde Comprobantes pareciera funcionar mientras el POS fallaba por DNS.
// `solicitarCAE()` está BLOQUEADO deliberadamente: nunca debe fabricar un CAE,
// ni para testing. La única fuente de verdad para emisión fiscal es
// comprobanteService.crear()/emitir() → ArcaService → Edge Function afip-cae
// → WSFEv1 real (ver src/services/comprobanteService.ts).
//
// facturacionService.emitirComprobante() (más abajo) es la única llamadora de
// solicitarCAE() y no tiene callers en la UI (confirmado por auditoría); queda
// así por compatibilidad de tipos pero ahora falla en vez de simular éxito.
// ============================================
export const afipService = {
  /**
   * BLOQUEADO — nunca debe fabricar un CAE. Ver comprobanteService.crear/emitir.
   * (El tipo de retorno se conserva igual al original para no romper el
   * contrato de los callers legacy; en runtime esta función siempre lanza.)
   */
  async solicitarCAE(_comprobante: Partial<Comprobante>): Promise<{
    success: boolean;
    cae: string;
    caeVencimiento: string;
    numero: string;
    response: any;
    error?: string;
  }> {
    throw new Error(
      'afipService.solicitarCAE() está deshabilitado: nunca debe fabricar un CAE. ' +
      'Usá comprobanteService (crear/emitir) para emisión fiscal real vía ARCA.'
    );
  },

  /**
   * BLOQUEADO — ver solicitarCAE(). No debe usarse para generar un CAE real ni de prueba.
   */
  generarCAEFake(): string {
    throw new Error('afipService.generarCAEFake() está deshabilitado: no se deben fabricar CAE.');
  },

  /**
   * Calcular vencimiento del CAE (15 días hábiles)
   */
  calcularVencimientoCAE(): string {
    const hoy = new Date();
    const vencimiento = new Date(hoy);
    vencimiento.setDate(hoy.getDate() + 15);
    return vencimiento.toISOString();
  },

  /**
   * Generar número de comprobante (mock AFIP)
   */
  async generarNumeroAFIP(_tipo: TipoComprobante, puntoVenta: string): Promise<string> {
    // En producción, AFIP devuelve el número oficial
    const ultimoNumero = Math.floor(Math.random() * 999999) + 1;
    return `${puntoVenta}-${ultimoNumero.toString().padStart(8, '0')}`;
  },

  /**
   * Obtener código numérico del tipo de comprobante para AFIP
   */
  /**
   * Código WSFEv1 de los tipos con código FIJO.
   *
   * `nota_credito` ya NO está mapeada: tenía un 3 genérico, que es NC-A,
   * mientras que la única NC real de este sistema es NC-C (13). El CbteTipo de
   * una nota de crédito depende del comprobante original (A→3, B→8, C→13) y
   * sólo puede resolverse con `tipo_comprobante_fiscal` — ver
   * src/lib/fiscalIdentity.ts. Devuelve 0 (fail-closed) para lo que no puede
   * resolver.
   */
  getCodigoTipoComprobante(tipo: TipoComprobante): number {
    return resolverCbteTipo({ tipo }) ?? 0;
  },

  /**
   * Consultar estado de servidor AFIP (MOCK)
   */
  async consultarEstadoServidor(): Promise<{
    appServer: string;
    dbServer: string;
    authServer: string;
  }> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      appServer: 'OK',
      dbServer: 'OK',
      authServer: 'OK'
    };
  },

  /**
   * Preparar estructura para integración real
   * Esto se usará cuando conectes AFIP real
   */
  async getToken(): Promise<string | null> {
    // TODO: Implementar OAuth2 con AFIP
    console.log('TODO: Implementar getToken() para AFIP real');
    return null;
  },

  /**
   * Estructura para emitir factura real
   */
  async emitirFacturaReal(_data: any): Promise<any> {
    // TODO: Implementar llamada real a AFIP
    console.log('TODO: Implementar emitirFacturaReal()');
    throw new Error('AFIP real no implementado aún');
  }
};

// ============================================
// SERVICIO DE COMPROBANTES
// ============================================
export const facturacionService = {
  /**
   * Obtener comprobante por ID con items
   */
  async getComprobanteById(id: string): Promise<Comprobante | null> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error obteniendo comprobante:', error);
      return null;
    }

    // Cargar items por separado
    const { data: items, error: itemsError } = await supabase
      .from('comprobante_items')
      .select('*')
      .eq('comprobante_id', id)
      .order('orden', { ascending: true });

    if (itemsError) {
      console.error('Error obteniendo items:', itemsError);
    }

    // Cargar pagos (para widget de cobro)
    const { data: pagos } = await supabase
      .from('comprobante_payments')
      .select('payment_method, amount, amount_ars, notes, date')
      .eq('comprobante_id', id)
      .order('created_at', { ascending: true });

    // Cargar cliente
    const cliente = data.customer_id ? await supabase
      .from('customers')
      .select('*')
      .eq('id', data.customer_id)
      .single()
      .then(({ data: c }) => c, () => null) : null;

    // Cargar orden
    const orden = data.order_id ? await supabase
      .from('orders')
      .select('id')
      .eq('id', data.order_id)
      .single()
      .then(({ data: o }) => o, () => null) : null;

    return {
      ...data,
      items: items || [],
      pagos: pagos || [],
      cliente,
      orden
    } as any;
  },

  /**
   * Obtener comprobantes por orden
   */
  async getComprobantesByOrder(orderId: string): Promise<Comprobante[]> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error obteniendo comprobantes:', error);
      return [];
    }

    return data || [];
  },

  /**
   * Listar todos los comprobantes con filtros
   */
  async listarComprobantes(filters?: {
    tipo?: TipoComprobante;
    estado?: 'borrador' | 'emitido' | 'anulado';
    clienteId?: string;
    fechaDesde?: string;
    fechaHasta?: string;
    businessId?: string;
  }): Promise<Comprobante[]> {
    let query = supabase
      .from('comprobantes')
      .select('*, comprobante_items(id, currency, subtotal)')
      .order('created_at', { ascending: false });

    if (filters?.businessId) {
      query = query.eq('business_id', filters.businessId);
    }
    if (filters?.tipo) {
      query = query.eq('tipo', filters.tipo);
    }
    if (filters?.estado) {
      query = query.eq('estado', filters.estado);
    }
    if (filters?.clienteId) {
      query = query.eq('customer_id', filters.clienteId);
    }
    if (filters?.fechaDesde) {
      query = query.gte('fecha', filters.fechaDesde);
    }
    if (filters?.fechaHasta) {
      query = query.lte('fecha', filters.fechaHasta);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error listando comprobantes:', error);
      return [];
    }

    // Compute total_ars / total_usd from joined items on the fly
    // (handles old records where these columns may not be set correctly)
    const result = (data || []).map((comp: any) => {
      const itemsList: { currency?: string; subtotal: number }[] = comp.comprobante_items || [];
      const computed_ars = itemsList
        .filter(i => (i.currency || 'ARS') === 'ARS')
        .reduce((s, i) => s + (i.subtotal || 0), 0);
      const computed_usd = itemsList
        .filter(i => i.currency === 'USD')
        .reduce((s, i) => s + (i.subtotal || 0), 0);
      return {
        ...comp,
        total_ars: computed_ars,
        total_usd: computed_usd,
        // Remove nested items from the flat comprobante object
        comprobante_items: undefined,
      };
    });

    return result as Comprobante[];
  },

  /**
   * Actualizar comprobante (solo si está en borrador)
   */
  async actualizarComprobante(
    id: string,
    updates: Partial<Comprobante>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Verificar que esté en borrador
      const { data: actual } = await supabase
        .from('comprobantes')
        .select('estado')
        .eq('id', id)
        .single();

      if (actual?.estado !== 'borrador') {
        return {
          success: false,
          error: 'Solo se pueden editar comprobantes en estado borrador'
        };
      }

      const { error } = await supabase
        .from('comprobantes')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw error;

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  /**
   * Agregar item a comprobante
   */
  async agregarItem(
    comprobanteId: string,
    item: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      inventory_id?: string;
    },
    businessId: string,
    createdBy?: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Verificar que esté en borrador
      const { data: comprobante } = await supabase
        .from('comprobantes')
        .select('estado')
        .eq('id', comprobanteId)
        .single();

      if (comprobante?.estado !== 'borrador') {
        return {
          success: false,
          error: 'Solo se pueden agregar items en estado borrador'
        };
      }

      // Obtener último orden
      const { data: ultimo } = await supabase
        .from('comprobante_items')
        .select('orden')
        .eq('comprobante_id', comprobanteId)
        .order('orden', { ascending: false })
        .limit(1)
        .single();

      const nuevoOrden = (ultimo?.orden || 0) + 1;

      const { error } = await supabase
        .from('comprobante_items')
        .insert({
          comprobante_id: comprobanteId,
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          precio_unitario: item.precio_unitario,
          subtotal: item.cantidad * item.precio_unitario,
          inventory_id: item.inventory_id || null,
          orden: nuevoOrden,
          business_id: businessId,
          created_by: createdBy || null
        });

      if (error) throw error;

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  /**
   * Eliminar item de comprobante
   */
  async eliminarItem(itemId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('comprobante_items')
        .delete()
        .eq('id', itemId);

      if (error) throw error;

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  /**
   * Actualizar item
   */
  async actualizarItem(
    itemId: string,
    updates: Partial<ComprobanteItem>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const subtotal = updates.cantidad && updates.precio_unitario
        ? updates.cantidad * updates.precio_unitario
        : undefined;

      const { error } = await supabase
        .from('comprobante_items')
        .update({
          ...updates,
          ...(subtotal !== undefined && { subtotal })
        })
        .eq('id', itemId);

      if (error) throw error;

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  /**
   * ⚠️ LEGACY / SIN CALLERS EN LA UI (auditoría ARCA 2026-07-01).
   * Delega en afipService.solicitarCAE(), que está deliberadamente bloqueado
   * (nunca fabrica un CAE) — esta función ahora siempre falla de forma
   * explícita en vez de simular una emisión. Para emisión fiscal real usar
   * comprobanteService.crear() / comprobanteService.emitir().
   */
  async emitirComprobante(id: string): Promise<{
    success: boolean;
    comprobante?: Comprobante;
    error?: string;
  }> {
    try {
      // 1. Obtener comprobante
      const comprobante = await this.getComprobanteById(id);
      if (!comprobante) {
        return { success: false, error: 'Comprobante no encontrado' };
      }

      if (comprobante.estado !== 'borrador') {
        return { success: false, error: 'El comprobante ya fue emitido o anulado' };
      }

      // 2. Llamar a AFIP (mock)
      const afipResponse = await afipService.solicitarCAE(comprobante);

      if (!afipResponse.success) {
        return { success: false, error: afipResponse.error };
      }

      // 3. Actualizar comprobante con datos AFIP
      const { error } = await supabase
        .from('comprobantes')
        .update({
          estado: 'emitido',
          numero: afipResponse.numero,
          cae: afipResponse.cae,
          cae_vencimiento: afipResponse.caeVencimiento,
          afip_response: afipResponse.response,
          fecha: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw error;

      // 4. Obtener comprobante actualizado
      const comprobanteActualizado = await this.getComprobanteById(id);

      return {
        success: true,
        comprobante: comprobanteActualizado || undefined
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      console.error('Error emitiendo comprobante:', err);
      return { success: false, error: message };
    }
  },

  /**
   * Anular comprobante
   */
  async anularComprobante(id: string, motivo?: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const { data: comprobante } = await supabase
        .from('comprobantes')
        .select('estado, cae, afip_response')
        .eq('id', id)
        .single();

      if (comprobante?.estado === 'anulado') {
        return { success: false, error: 'El comprobante ya está anulado' };
      }

      // TODO: Si tiene CAE, debería generar nota de crédito en AFIP
      if (comprobante?.cae) {
        console.log('TODO: Generar nota de crédito en AFIP para comprobante anulado');
      }

      const { error } = await supabase
        .from('comprobantes')
        .update({
          estado: 'anulado',
          afip_response: {
            ...(comprobante?.afip_response || {}),
            anulacion: {
              motivo: motivo || null,
              fecha: new Date().toISOString()
            }
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw error;

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  /**
   * Obtener estadísticas de facturación
   */
  async getEstadisticas(periodo?: { desde: string; hasta: string }): Promise<{
    totalComprobantes: number;
    totalFacturado: number;
    porTipo: Record<TipoComprobante, { cantidad: number; total: number }>;
  }> {
    let query = supabase
      .from('comprobantes')
      .select('tipo, total')
      .eq('estado', 'emitido');

    if (periodo) {
      query = query
        .gte('fecha', periodo.desde)
        .lte('fecha', periodo.hasta);
    }

    const { data, error } = await query;

    if (error || !data) {
      return {
        totalComprobantes: 0,
        totalFacturado: 0,
        porTipo: {
          factura_a: { cantidad: 0, total: 0 },
          factura_c: { cantidad: 0, total: 0 },
          remito: { cantidad: 0, total: 0 },
          nota_credito: { cantidad: 0, total: 0 }
        }
      };
    }

    const stats = {
      totalComprobantes: data.length,
      totalFacturado: data.reduce((sum, c) => sum + (c.total || 0), 0),
      porTipo: {
        factura_a: { cantidad: 0, total: 0 },
        factura_c: { cantidad: 0, total: 0 },
        remito: { cantidad: 0, total: 0 },
        nota_credito: { cantidad: 0, total: 0 }
      } as Record<TipoComprobante, { cantidad: number; total: number }>
    };

    data.forEach(c => {
      if (c.tipo in stats.porTipo) {
        stats.porTipo[c.tipo as TipoComprobante].cantidad++;
        stats.porTipo[c.tipo as TipoComprobante].total += c.total || 0;
      }
    });

    return stats;
  }
};

// Exportar default
export default facturacionService;
