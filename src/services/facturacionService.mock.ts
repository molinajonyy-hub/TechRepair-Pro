// =====================================================
// SERVICIO MOCK - FUNCIONA SIN SUPABASE
// Usar esto hasta que se resuelvan los problemas de RLS
// =====================================================

import { TipoComprobante, Comprobante, ComprobanteItem } from './facturacionService';

// Storage local para comprobantes
const storage = {
  comprobantes: [] as Comprobante[],
  items: [] as ComprobanteItem[],
  nextId: 1
};

// Generar ID único
const generateId = () => `mock-${Date.now()}-${storage.nextId++}`;

// Generar número de comprobante fake
const generateNumero = (_tipo: TipoComprobante, puntoVenta: string) => {
  const num = Math.floor(Math.random() * 999999) + 1;
  return `${puntoVenta}-${num.toString().padStart(8, '0')}`;
};

// Calcular totales
const calcularTotales = (items: { cantidad: number; precio_unitario: number }[], tipo: TipoComprobante) => {
  const subtotal = items.reduce((sum, item) => sum + (item.cantidad * item.precio_unitario), 0);
  const impuestos = tipo === 'factura_a' ? subtotal * 0.21 : 0;
  return { subtotal, impuestos, total: subtotal + impuestos };
};

export const facturacionServiceMock = {
  // Crear comprobante con orden
  async crearComprobante(data: {
    order_id: string;
    customer_id: string;
    tipo: TipoComprobante;
    punto_venta?: string;
    condicion_fiscal?: string;
    items: { descripcion: string; cantidad: number; precio_unitario: number; inventory_id?: string }[];
  }) {
    try {
      const { subtotal, impuestos, total } = calcularTotales(data.items, data.tipo);
      
      const comprobante: Comprobante = {
        id: generateId(),
        order_id: data.order_id,
        customer_id: data.customer_id,
        business_id: null,
        tipo: data.tipo,
        numero: generateNumero(data.tipo, data.punto_venta || '0001'),
        punto_venta: data.punto_venta || '0001',
        fecha: new Date().toISOString(),
        subtotal,
        impuestos,
        total,
        currency: 'ARS',
        total_ars: total,
        total_usd: 0,
        exchange_rate: 1,
        estado: 'borrador',
        cae: null,
        cae_vencimiento: null,
        afip_response: null,
        condicion_fiscal: data.condicion_fiscal || 'Consumidor Final',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Crear items
      const items: ComprobanteItem[] = data.items.map((item, index) => ({
        id: generateId(),
        comprobante_id: comprobante.id,
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        subtotal: item.cantidad * item.precio_unitario,
        currency: 'ARS' as const,
        exchange_rate: 1,
        inventory_id: item.inventory_id || null,
        orden: index
      }));

      storage.comprobantes.push(comprobante);
      storage.items.push(...items);

      return { success: true, comprobante };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido' };
    }
  },

  // Crear comprobante independiente
  async crearComprobanteIndependiente(data: {
    tipo: TipoComprobante;
    punto_venta: string;
    condicion_fiscal: string;
    customer_id: string;
    items: { descripcion: string; cantidad: number; precio_unitario: number }[];
  }) {
    return this.crearComprobante({
      ...data,
      order_id: `独立-${generateId()}`,
    });
  },

  // Obtener comprobante por ID
  async getComprobanteById(id: string): Promise<Comprobante | null> {
    const comprobante = storage.comprobantes.find(c => c.id === id);
    if (!comprobante) return null;
    
    // Agregar items al comprobante
    const items = storage.items.filter(i => i.comprobante_id === id);
    return { ...comprobante, items } as any;
  },

  // Obtener comprobantes por orden
  async getComprobantesByOrder(orderId: string): Promise<Comprobante[]> {
    return storage.comprobantes.filter(c => c.order_id === orderId);
  },

  // Listar todos los comprobantes
  async listarComprobantes(filters?: any): Promise<Comprobante[]> {
    let result = [...storage.comprobantes];
    
    if (filters?.tipo) {
      result = result.filter(c => c.tipo === filters.tipo);
    }
    if (filters?.estado) {
      result = result.filter(c => c.estado === filters.estado);
    }
    
    return result.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  },

  // Emitir comprobante (mock)
  async emitirComprobante(id: string) {
    const comprobante = storage.comprobantes.find(c => c.id === id);
    if (!comprobante) {
      return { success: false, error: 'Comprobante no encontrado' };
    }

    comprobante.estado = 'emitido';
    comprobante.cae = `7${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    comprobante.cae_vencimiento = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    
    return { success: true, comprobante };
  },

  // Anular comprobante
  async anularComprobante(id: string, _motivo?: string) {
    const comprobante = storage.comprobantes.find(c => c.id === id);
    if (!comprobante) {
      return { success: false, error: 'Comprobante no encontrado' };
    }

    comprobante.estado = 'anulado';
    return { success: true };
  },

  // Agregar item
  async agregarItem(comprobanteId: string, item: any) {
    const comprobante = storage.comprobantes.find(c => c.id === comprobanteId);
    if (!comprobante) {
      return { success: false, error: 'Comprobante no encontrado' };
    }

    const newItem: ComprobanteItem = {
      id: generateId(),
      comprobante_id: comprobanteId,
      descripcion: item.descripcion,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario,
      subtotal: item.cantidad * item.precio_unitario,
      currency: item.currency || 'ARS',
      exchange_rate: item.exchange_rate || 1,
      inventory_id: item.inventory_id || null,
      orden: storage.items.filter(i => i.comprobante_id === comprobanteId).length
    };

    storage.items.push(newItem);
    return { success: true };
  },

  // Actualizar item
  async actualizarItem(itemId: string, updates: Partial<ComprobanteItem>) {
    const item = storage.items.find(i => i.id === itemId);
    if (!item) {
      return { success: false, error: 'Item no encontrado' };
    }

    Object.assign(item, updates);
    if (updates.cantidad || updates.precio_unitario) {
      item.subtotal = item.cantidad * item.precio_unitario;
    }

    return { success: true };
  },

  // Eliminar item
  async eliminarItem(itemId: string) {
    const index = storage.items.findIndex(i => i.id === itemId);
    if (index === -1) {
      return { success: false, error: 'Item no encontrado' };
    }

    storage.items.splice(index, 1);
    return { success: true };
  },

  // Recalcular totales
  async recalcularTotales(comprobanteId: string) {
    const comprobante = storage.comprobantes.find(c => c.id === comprobanteId);
    if (!comprobante) return;

    const items = storage.items.filter(i => i.comprobante_id === comprobanteId);
    const { subtotal, impuestos, total } = calcularTotales(items, comprobante.tipo);

    comprobante.subtotal = subtotal;
    comprobante.impuestos = impuestos;
    comprobante.total = total;
  },

  // Actualizar comprobante
  async actualizarComprobante(id: string, updates: Partial<Comprobante>) {
    const comprobante = storage.comprobantes.find(c => c.id === id);
    if (!comprobante) {
      return { success: false, error: 'Comprobante no encontrado' };
    }

    if (comprobante.estado !== 'borrador') {
      return { success: false, error: 'Solo se pueden editar comprobantes en borrador' };
    }

    Object.assign(comprobante, updates);
    comprobante.updated_at = new Date().toISOString();

    return { success: true };
  },

  // Estadísticas
  async getEstadisticas(_periodo?: any) {
    const emitidos = storage.comprobantes.filter(c => c.estado === 'emitido');
    
    const stats = {
      totalComprobantes: emitidos.length,
      totalFacturado: emitidos.reduce((sum, c) => sum + c.total, 0),
      porTipo: {
        factura_a: { cantidad: 0, total: 0 },
        factura_c: { cantidad: 0, total: 0 },
        remito: { cantidad: 0, total: 0 },
        nota_credito: { cantidad: 0, total: 0 }
      }
    };

    emitidos.forEach(c => {
      if (c.tipo in stats.porTipo) {
        stats.porTipo[c.tipo as TipoComprobante].cantidad++;
        stats.porTipo[c.tipo as TipoComprobante].total += c.total;
      }
    });

    return stats;
  },

  // Limpiar storage (para testing)
  clearStorage() {
    storage.comprobantes = [];
    storage.items = [];
    storage.nextId = 1;
  },

  // Obtener storage (para debugging)
  getStorage() {
    return { ...storage };
  }
};

// Re-exportar tipos
export type { TipoComprobante, Comprobante, ComprobanteItem };
