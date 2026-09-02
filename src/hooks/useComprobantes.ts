import { useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { facturacionService, afipService, TipoComprobante, Comprobante, ComprobanteItem } from '../services/facturacionService';
import { toErrorMessage } from '../utils/formatMessage';

export interface UseComprobantesReturn {
  comprobantes: Comprobante[];
  comprobanteActual: Comprobante | null;
  loading: boolean;
  emitiendo: boolean;
  error: string | null;
  
  // CRUD
  // La creación de comprobantes es RPC-only (Lote 3 Phase C): el POS crea por
  // create_comprobante_checkout_atomic y las NC por
  // create_credit_note_from_comprobante, ambas vía comprobanteService.
  cargarComprobante: (id: string) => Promise<void>;
  cargarComprobantesByOrder: (orderId: string) => Promise<void>;
  listarComprobantes: (filters?: {
    tipo?: TipoComprobante;
    estado?: 'borrador' | 'emitido' | 'anulado';
    clienteId?: string;
  }) => Promise<void>;
  
  // Items
  agregarItem: (item: {
    descripcion: string;
    cantidad: number;
    precio_unitario: number;
    inventory_id?: string;
  }) => Promise<boolean>;
  
  actualizarItem: (itemId: string, updates: Partial<ComprobanteItem>) => Promise<boolean>;
  eliminarItem: (itemId: string) => Promise<boolean>;
  
  // Acciones
  emitirComprobante: (id?: string) => Promise<boolean>;
  anularComprobante: (id?: string, motivo?: string) => Promise<boolean>;
  
  // Calculadora
  calcularTotales: (items: { cantidad: number; precio_unitario: number }[], tipo: TipoComprobante) => {
    subtotal: number;
    impuestos: number;
    total: number;
  };
  
  // Reset
  limpiarError: () => void;
  reset: () => void;
}

export function useComprobantes(_comprobanteId?: string): UseComprobantesReturn {
  const { businessId, user } = useAuth();
  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [comprobanteActual, setComprobanteActual] = useState<Comprobante | null>(null);
  const [loading, setLoading] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargarComprobante = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    
    try {
      const comprobante = await facturacionService.getComprobanteById(id);
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
      const comprobantes = await facturacionService.getComprobantesByOrder(orderId);
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
      const comprobantes = await facturacionService.listarComprobantes({
        ...filters,
        businessId: businessId ?? undefined
      });
      setComprobantes(comprobantes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

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
      const result = await facturacionService.agregarItem(comprobanteActual.id, item, businessId!, user?.id);
      
      if (result.success) {
        await cargarComprobante(comprobanteActual.id);
        return true;
      } else {
        setError(toErrorMessage(result.error, 'Error agregando item'));
        return false;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      return false;
    } finally {
      setLoading(false);
    }
  }, [comprobanteActual, cargarComprobante, businessId, user?.id]);

  const actualizarItem = useCallback(async (
    itemId: string,
    updates: Partial<ComprobanteItem>
  ): Promise<boolean> => {
    setLoading(true);
    
    try {
      const result = await facturacionService.actualizarItem(itemId, updates);
      
      if (result.success) {
        if (comprobanteActual) {
          await cargarComprobante(comprobanteActual.id);
        }
        return true;
      } else {
        setError(toErrorMessage(result.error, 'Error actualizando item'));
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
      const result = await facturacionService.eliminarItem(itemId);
      
      if (result.success) {
        if (comprobanteActual) {
          await cargarComprobante(comprobanteActual.id);
        }
        return true;
      } else {
        setError(toErrorMessage(result.error, 'Error eliminando item'));
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
      const result = await facturacionService.emitirComprobante(targetId);
      
      if (result.success && result.comprobante) {
        setComprobanteActual(result.comprobante);
        setComprobantes(prev => prev.map(c => 
          c.id === result.comprobante!.id ? result.comprobante! : c
        ));
        return true;
      } else {
        setError(toErrorMessage(result.error, 'Error emitiendo comprobante'));
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
      const result = await facturacionService.anularComprobante(targetId, motivo);
      
      if (result.success) {
        if (comprobanteActual?.id === targetId) {
          await cargarComprobante(targetId);
        }
        return true;
      } else {
        setError(toErrorMessage(result.error, 'Error anulando comprobante'));
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
export { facturacionService, afipService };
// Re-exportar tipos del nuevo servicio para compatibilidad hacia adelante
export type { TipoComprobante, ComprobanteItem };
export type { Comprobante } from '../services/comprobanteService';
