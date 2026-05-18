import { supabase } from '../lib/supabase';

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
// MOCK SERVICE AFIP (ARCA)
// ============================================
export const afipService = {
  /**
   * Solicitar CAE a AFIP (MOCK)
   * En producción, esto llamaría a la API real de AFIP
   */
  async solicitarCAE(comprobante: Partial<Comprobante>): Promise<{
    success: boolean;
    cae: string;
    caeVencimiento: string;
    numero: string;
    response: any;
    error?: string;
  }> {
    // Simular delay de red
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Mock de respuesta AFIP
    const mockResponse = {
      success: true,
      cae: this.generarCAEFake(),
      caeVencimiento: this.calcularVencimientoCAE(),
      numero: await this.generarNumeroAFIP(comprobante.tipo!, comprobante.punto_venta!),
      response: {
        Codigo: 0,
        Mensaje: 'OK',
        CAE: this.generarCAEFake(),
        CAEFchVto: this.calcularVencimientoCAE(),
        NroComprobante: Math.floor(Math.random() * 1000000).toString().padStart(8, '0'),
        PtoVta: comprobante.punto_venta,
        CbteTipo: this.getCodigoTipoComprobante(comprobante.tipo!),
      }
    };
    
    // Simular error aleatorio (10% chance) para testing
    if (Math.random() < 0.1) {
      return {
        ...mockResponse,
        success: false,
        error: 'Error simulado de AFIP: Servicio no disponible'
      };
    }
    
    return mockResponse;
  },

  /**
   * Generar CAE fake para testing
   */
  generarCAEFake(): string {
    const timestamp = Date.now().toString().slice(-10);
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `7${timestamp}${random}`;
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
  getCodigoTipoComprobante(tipo: TipoComprobante): number {
    const codigos: Record<TipoComprobante, number> = {
      'factura_a': 1,
      'nota_credito': 3,  // Nota de Crédito A
      'factura_c': 11,
      'remito': 0  // Remito no es comprobante fiscal electrónico
    };
    return codigos[tipo] || 0;
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
   * Crear comprobante desde orden
   */
  async crearComprobante(data: CrearComprobanteDTO): Promise<{
    success: boolean;
    comprobante?: Comprobante;
    error?: string;
  }> {
    try {
      // 1. Crear comprobante
      const { data: comprobante, error: comprobanteError } = await supabase
        .from('comprobantes')
        .insert({
          order_id: data.order_id,
          customer_id: data.customer_id,
          tipo: data.tipo,
          punto_venta: data.punto_venta || '0001',
          estado: 'borrador',
          condicion_fiscal: data.condicion_fiscal || 'Consumidor Final',
          business_id: data.business_id,
          created_by: data.created_by || null,
          subtotal: 0,
          impuestos: 0,
          total: 0
        })
        .select()
        .single();

      if (comprobanteError) throw comprobanteError;

      // 2. Crear items
      const itemsToInsert = data.items.map((item, index) => ({
        comprobante_id: comprobante.id,
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        subtotal: item.cantidad * item.precio_unitario,
        inventory_id: item.inventory_id || null,
        orden: index,
        business_id: data.business_id,
        created_by: data.created_by || null
      }));

      const { error: itemsError } = await supabase
        .from('comprobante_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // 3. Recalcular totales
      await this.recalcularTotales(comprobante.id);

      // 4. Actualizar orden con referencia al comprobante
      const { error: orderError } = await supabase
        .from('orders')
        .update({ comprobante_id: comprobante.id })
        .eq('id', data.order_id);

      if (orderError) throw orderError;

      // 5. Obtener comprobante completo
      const comprobanteCompleto = await this.getComprobanteById(comprobante.id);

      return {
        success: true,
        comprobante: comprobanteCompleto || undefined
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      console.error('Error creando comprobante:', err);
      return { success: false, error: message };
    }
  },

  /**
   * Crear comprobante independiente (sin orden)
   */
  async crearComprobanteIndependiente(data: {
    tipo: TipoComprobante;
    punto_venta: string;
    condicion_fiscal: string;
    customer_id: string | null;
    business_id: string;
    created_by?: string;
    exchange_rate?: number;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      currency?: 'ARS' | 'USD';
      exchange_rate?: number;
      inventory_id?: string;
    }[];
  }): Promise<{
    success: boolean;
    comprobante?: Comprobante;
    error?: string;
  }> {
    try {
      const exchangeRate = data.exchange_rate || 1;

      // Determinar moneda dominante del comprobante (la que tenga más items)
      const itemsUSD = data.items.filter(i => i.currency === 'USD').length;
      const currency: 'ARS' | 'USD' = itemsUSD > data.items.length / 2 ? 'USD' : 'ARS';

      // 1. Crear comprobante sin orden
      const { data: comprobante, error: comprobanteError } = await supabase
        .from('comprobantes')
        .insert({
          customer_id: data.customer_id,
          tipo: data.tipo,
          punto_venta: data.punto_venta || '0001',
          estado: 'borrador',
          condicion_fiscal: data.condicion_fiscal || 'Consumidor Final',
          business_id: data.business_id,
          created_by: data.created_by || null,
          currency,
          exchange_rate: exchangeRate,
          subtotal: 0,
          impuestos: 0,
          total: 0,
          total_ars: 0,
          total_usd: 0
        })
        .select()
        .single();

      if (comprobanteError) throw comprobanteError;

      // 2. Crear items
      if (!data.items || data.items.length === 0) {
        throw new Error('Debés agregar al menos un item al comprobante');
      }

      const itemsToInsert = data.items.map((item, index) => ({
        comprobante_id: comprobante.id,
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        subtotal: item.cantidad * item.precio_unitario,
        currency: item.currency || 'ARS',
        exchange_rate: item.exchange_rate || exchangeRate,
        inventory_id: item.inventory_id || null,
        orden: index,
        business_id: data.business_id,
        created_by: data.created_by || null
      }));

      const { error: itemsError } = await supabase
        .from('comprobante_items')
        .insert(itemsToInsert);

      if (itemsError) throw itemsError;

      // 3. Recalcular totales
      await this.recalcularTotales(comprobante.id);

      // 4. Obtener comprobante completo
      const comprobanteCompleto = await this.getComprobanteById(comprobante.id);

      return {
        success: true,
        comprobante: comprobanteCompleto || undefined
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      console.error('Error creando comprobante independiente:', err);
      return { success: false, error: message };
    }
  },

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
   * Emitir comprobante (llamar a AFIP mock)
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
   * Recalcular totales manualmente
   */
  async recalcularTotales(comprobanteId: string): Promise<void> {
    // Try the RPC first
    const { error: rpcError } = await supabase.rpc('recalcular_totales_comprobante', {
      p_comprobante_id: comprobanteId
    });
    if (rpcError) {
      console.error('Error en RPC recalcular_totales:', rpcError);
    }

    // Always compute and persist total_ars / total_usd from items directly
    const { data: itemRows } = await supabase
      .from('comprobante_items')
      .select('currency, subtotal')
      .eq('comprobante_id', comprobanteId);

    if (itemRows && itemRows.length > 0) {
      const total_ars = itemRows
        .filter((i: any) => (i.currency || 'ARS') === 'ARS')
        .reduce((s: number, i: any) => s + (i.subtotal || 0), 0);
      const total_usd = itemRows
        .filter((i: any) => i.currency === 'USD')
        .reduce((s: number, i: any) => s + (i.subtotal || 0), 0);

      await supabase
        .from('comprobantes')
        .update({ total_ars, total_usd })
        .eq('id', comprobanteId);
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
