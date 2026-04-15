import { supabase } from '../lib/supabase';

export interface Order {
  id: string;
  customer_id: string;
  status: string;
  reported_issue?: string;
  diagnosis?: string;
  estimated_total?: number;
  final_total?: number;
  technician_id?: string;
  notes?: string;
  business_id: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export const orderService = {
  /**
   * Obtener todas las órdenes
   */
  async getAllOrders(businessId: string): Promise<Order[]> {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        customer:customers(name, phone, email),
        device:devices(type, brand, model)
      `)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error('Error al obtener órdenes');
    }

    return data || [];
  },

  /**
   * Obtener orden por ID
   */
  async getOrderById(orderId: string, businessId: string): Promise<Order | null> {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        customer:customers(*),
        device:devices(*)
      `)
      .eq('id', orderId)
      .eq('business_id', businessId)
      .single();

    if (error) {
      throw new Error('Error al obtener orden');
    }

    return data;
  },

  /**
   * Crear nueva orden
   */
  async createOrder(
    order: Omit<Order, 'id' | 'created_at' | 'updated_at'>,
    businessId: string,
    userId: string
  ): Promise<Order> {
    const { data, error } = await supabase
      .from('orders')
      .insert({
        ...order,
        business_id: businessId,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al crear orden');
    }

    return data;
  },

  /**
   * Actualizar orden
   */
  async updateOrder(
    orderId: string,
    order: Partial<Omit<Order, 'id' | 'created_at' | 'updated_at'>>,
    businessId: string
  ): Promise<Order> {
    const { data, error } = await supabase
      .from('orders')
      .update(order)
      .eq('id', orderId)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al actualizar orden');
    }

    return data;
  },

  /**
   * Cambiar estado de orden
   */
  async updateOrderStatus(
    orderId: string,
    status: string,
    businessId: string
  ): Promise<void> {
    const { error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .eq('business_id', businessId);

    if (error) {
      throw new Error('Error al actualizar estado de orden');
    }
  },

  /**
   * Buscar órdenes
   */
  async searchOrders(query: string, businessId: string): Promise<Order[]> {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        customer:customers(name, phone, email),
        device:devices(type, brand, model)
      `)
      .eq('business_id', businessId)
      .or(`status.ilike.%${query}%`)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error('Error al buscar órdenes');
    }

    return data || [];
  },
};
