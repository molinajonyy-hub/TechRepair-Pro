// =====================================================
// HOOK MOCK - FUNCIONA SIN SUPABASE
// Usar esto hasta que se resuelvan los problemas de RLS
// =====================================================

import { useState, useCallback } from 'react';
import { facturacionServiceMock, TipoComprobante, Comprobante, ComprobanteItem } from '../services/facturacionService.mock';

export interface UseComprobantesReturn {
  comprobantes: Comprobante[];
  comprobanteActual: Comprobante | null;
  loading: boolean;
  emitiendo: boolean;
  error: string | null;
  
  crearComprobante: (data: {
    order_id: string;
    customer_id: string;
    tipo: TipoComprobante;
    punto_venta?: string;
    condicion_fiscal?: string;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      inventory_id?: string;
    }[];
  }) => Promise<boolean>;

  crearComprobanteIndependiente: (data: {
    tipo: TipoComprobante;
    punto_venta: string;
    condicion_fiscal: string;
    customer_id: string;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
    }[];
  }) => Promise<boolean>;
  
  cargarComprobante: (id: string) => Promise<void>;
  cargarComprobantesByOrder: (orderId: string) => Promise<void>;
  listarComprobantes: (filters?: {
    tipo?: TipoComprobante;
    estado?: 'borrador' | 'emitido' | 'anulado';
    clienteId?: string;
  }) => Promise<void>;
  
  agregarItem: (item: {
    descripcion: string;
    cantidad: number;
    precio_unitario: number;
    inventory_id?: string;
  }) => Promise<boolean>;
  
  actualizarItem: (itemId: string, updates: Partial<ComprobanteItem>) => Promise<boolean>;
  eliminarItem: (itemId: string) => Promise<boolean>;
  
  emitirComprobante: (id?: string) => Promise<boolean>;
  anularComprobante: (id?: string, motivo?: string) => Promise<boolean>;
  
  calcularTotales: (items: { cantidad: number; precio_unitario: number }[], tipo: TipoComprobante) => {
    subtotal: number;
    impuestos: number;
    total: number;
  };
  
  limpiarError: () => void;
  reset: () => void;
}

export function useComprobantesMock(_comprobanteId?: string): UseComprobantesReturn {
  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [comprobanteActual, setComprobanteActual] = useState<Comprobante | null>(null);
  const [loading, setLoading] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crearComprobante = useCallback(async (data: {
    order_id: string;
    customer_id: string;
    tipo: TipoComprobante;
    punto_venta?: string;
    condicion_fiscal?: string;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      inventory_id?: string;
    }[];
  }): Promise<boolean> => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await facturacionServiceMock.crearComprobante(data);
      
      if (result.success && result.comprobante) {
        setComprobanteActual(result.comprobante);
        setComprobantes(prev => [result.comprobante!, ...prev]);
        return true;
      } else {
        setError(result.error || 'Error creando comprobante');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const crearComprobanteIndependiente = useCallback(async (data: {
    tipo: TipoComprobante;
    punto_venta: string;
    condicion_fiscal: string;
    customer_id: string;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
    }[];
  }): Promise<boolean> => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await facturacionServiceMock.crearComprobanteIndependiente(data);
      
      if (result.success) {
        await listarComprobantes();
        return true;
      } else {
        setError(result.error || 'Error creando comprobante independiente');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const cargarComprobante = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    
    try {
      const comprobante = await facturacionServiceMock.getComprobanteById(id);
      setComprobanteActual(comprobante);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  const cargarComprobantesByOrder = useCallback(async (orderId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    
    try {
      const comprobantes = await facturacionServiceMock.getComprobantesByOrder(orderId);
      setComprobantes(comprobantes);
      if (comprobantes.length > 0) {
        setComprobanteActual(comprobantes[0]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  const listarComprobantes = useCallback(async (filters?: {
    tipo?: TipoComprobante;
    estado?: 'borrador' | 'emitido' | 'anulado';
    clienteId?: string;
  }): Promise<void> => {
    setLoading(true);
    setError(null);
    
    try {
      const comprobantes = await facturacionServiceMock.listarComprobantes(filters);
      setComprobantes(comprobantes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  const agregarItem = useCallback(async (item: {
    descripcion: string;
    cantidad: number;
    precio_unitario: number;
    inventory_id?: string;
  }): Promise<boolean> => {
    if (!comprobanteActual) {
      setError('No hay comprobante seleccionado');
      return false;
    }

    setLoading(true);
    
    try {
      const result = await facturacionServiceMock.agregarItem(comprobanteActual.id, item);
      
      if (result.success) {
        await cargarComprobante(comprobanteActual.id);
        return true;
      } else {
        setError(result.error || 'Error agregando item');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, [comprobanteActual, cargarComprobante]);

  const actualizarItem = useCallback(async (
    itemId: string,
    updates: Partial<ComprobanteItem>
  ): Promise<boolean> => {
    setLoading(true);
    
    try {
      const result = await facturacionServiceMock.actualizarItem(itemId, updates);
      
      if (result.success) {
        if (comprobanteActual) {
          await cargarComprobante(comprobanteActual.id);
        }
        return true;
      } else {
        setError(result.error || 'Error actualizando item');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, [comprobanteActual, cargarComprobante]);

  const eliminarItem = useCallback(async (itemId: string): Promise<boolean> => {
    setLoading(true);
    
    try {
      const result = await facturacionServiceMock.eliminarItem(itemId);
      
      if (result.success) {
        if (comprobanteActual) {
          await cargarComprobante(comprobanteActual.id);
        }
        return true;
      } else {
        setError(result.error || 'Error eliminando item');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, [comprobanteActual, cargarComprobante]);

  const emitirComprobante = useCallback(async (id?: string): Promise<boolean> => {
    const targetId = id || comprobanteActual?.id;
    
    if (!targetId) {
      setError('No hay comprobante para emitir');
      return false;
    }

    setEmitiendo(true);
    setError(null);
    
    try {
      const result = await facturacionServiceMock.emitirComprobante(targetId);
      
      if (result.success && result.comprobante) {
        setComprobanteActual(result.comprobante);
        setComprobantes(prev => prev.map(c => 
          c.id === result.comprobante!.id ? result.comprobante! : c
        ));
        return true;
      } else {
        setError(result.error || 'Error emitiendo comprobante');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setEmitiendo(false);
    }
  }, [comprobanteActual]);

  const anularComprobante = useCallback(async (id?: string, motivo?: string): Promise<boolean> => {
    const targetId = id || comprobanteActual?.id;
    
    if (!targetId) {
      setError('No hay comprobante para anular');
      return false;
    }

    setLoading(true);
    
    try {
      const result = await facturacionServiceMock.anularComprobante(targetId, motivo);
      
      if (result.success) {
        if (comprobanteActual?.id === targetId) {
          await cargarComprobante(targetId);
        }
        return true;
      } else {
        setError(result.error || 'Error anulando comprobante');
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, [comprobanteActual, cargarComprobante]);

  const calcularTotales = useCallback((
    items: { cantidad: number; precio_unitario: number }[],
    tipo: TipoComprobante
  ): { subtotal: number; impuestos: number; total: number } => {
    const subtotal = items.reduce((sum, item) => 
      sum + (item.cantidad * item.precio_unitario), 0
    );
    
    const impuestos = tipo === 'factura_a' ? subtotal * 0.21 : 0;
    const total = subtotal + impuestos;
    
    return { subtotal, impuestos, total };
  }, []);

  const limpiarError = useCallback(() => {
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setComprobantes([]);
    setComprobanteActual(null);
    setError(null);
  }, []);

  return {
    comprobantes,
    comprobanteActual,
    loading,
    emitiendo,
    error,
    crearComprobante,
    crearComprobanteIndependiente,
    cargarComprobante,
    cargarComprobantesByOrder,
    listarComprobantes,
    agregarItem,
    actualizarItem,
    eliminarItem,
    emitirComprobante,
    anularComprobante,
    calcularTotales,
    limpiarError,
    reset
  };
}

// Exportar también el servicio para uso directo
export { facturacionServiceMock };
export type { TipoComprobante, Comprobante, ComprobanteItem };
