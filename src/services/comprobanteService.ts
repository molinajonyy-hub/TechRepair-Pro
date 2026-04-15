import { supabase } from '../lib/supabase';

export interface Comprobante {
  id: string;
  order_id?: string;
  customer_id?: string;
  type: string;
  number: string;
  date: string;
  subtotal: number;
  tax: number;
  total: number;
  currency: 'ARS' | 'USD';
  total_ars: number;
  total_usd: number;
  exchange_rate: number;
  status: string;
  business_id: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface ComprobanteItem {
  id: string;
  comprobante_id: string;
  inventory_item_id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  currency: 'ARS' | 'USD';
  exchange_rate: number;
}

export const comprobanteService = {
  /**
   * Obtener todos los comprobantes
   */
  async getAllComprobantes(businessId: string): Promise<Comprobante[]> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select(`
        *,
        customer:customers(name, phone, email),
        items:comprobante_items(*)
      `)
      .eq('business_id', businessId)
      .order('date', { ascending: false });

    if (error) {
      throw new Error('Error al obtener comprobantes');
    }

    return data || [];
  },

  /**
   * Obtener comprobante por ID
   */
  async getComprobanteById(comprobanteId: string, businessId: string): Promise<Comprobante | null> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select(`
        *,
        customer:customers(*),
        items:comprobante_items(*)
      `)
      .eq('id', comprobanteId)
      .eq('business_id', businessId)
      .single();

    if (error) {
      throw new Error('Error al obtener comprobante');
    }

    return data;
  },

  /**
   * Generar número de comprobante usando RPC
   */
  async generateNumber(type: string, businessId: string): Promise<string> {
    const { data, error } = await supabase
      .rpc('generar_numero_comprobante', {
        p_tipo: type,
        p_business_id: businessId
      });

    if (error) {
      throw new Error('Error al generar número de comprobante');
    }

    return data;
  },

  /**
   * Crear nuevo comprobante
   */
  async createComprobante(
    comprobante: Omit<Comprobante, 'id' | 'created_at' | 'updated_at' | 'number'>,
    items: Omit<ComprobanteItem, 'id' | 'comprobante_id'>[],
    businessId: string,
    userId: string
  ): Promise<Comprobante> {
    // Generar número de comprobante
    const number = await this.generateNumber(comprobante.type, businessId);

    const exchangeRate = comprobante.exchange_rate || 1;

    // Calcular totales separados por moneda
    let subtotalARS = 0;
    let subtotalUSD = 0;
    for (const item of items) {
      const lineTotal = item.quantity * item.unit_price;
      const itemRate = item.exchange_rate || exchangeRate;
      if ((item.currency || 'ARS') === 'USD') {
        subtotalUSD += lineTotal;
        subtotalARS += lineTotal * itemRate;
      } else {
        subtotalARS += lineTotal;
        subtotalUSD += lineTotal / itemRate;
      }
    }

    const subtotal = subtotalARS;
    const tax = comprobante.type === 'factura_a' ? subtotal * 0.21 : 0;
    const total = subtotal + tax;
    const total_ars = total;
    const total_usd = subtotalUSD + (comprobante.type === 'factura_a' ? subtotalUSD * 0.21 : 0);

    const comprobanteData = {
      ...comprobante,
      number,
      business_id: businessId,
      created_by: userId,
      subtotal,
      tax,
      total,
      total_ars,
      total_usd,
      exchange_rate: exchangeRate,
      currency: comprobante.currency || 'ARS',
    };

    // Crear comprobante
    const { data: comprobanteResult, error: comprobanteError } = await supabase
      .from('comprobantes')
      .insert(comprobanteData)
      .select()
      .single();

    if (comprobanteError || !comprobanteResult) {
      throw new Error('Error al crear comprobante');
    }

    // Crear items de comprobante
    const comprobanteItems = items.map(item => ({
      ...item,
      comprobante_id: comprobanteResult.id,
      subtotal: item.quantity * item.unit_price,
    }));

    const { error: itemsError } = await supabase
      .from('comprobante_items')
      .insert(comprobanteItems);

    if (itemsError) {
      throw new Error('Error al crear items de comprobante');
    }

    return comprobanteResult;
  },

  /**
   * Anular comprobante
   */
  async cancelComprobante(comprobanteId: string, businessId: string): Promise<void> {
    const { error } = await supabase
      .from('comprobantes')
      .update({ status: 'cancelled' })
      .eq('id', comprobanteId)
      .eq('business_id', businessId);

    if (error) {
      throw new Error('Error al anular comprobante');
    }
  },

  /**
   * Obtener comprobantes por cliente
   */
  async getComprobantesByCustomer(customerId: string, businessId: string): Promise<Comprobante[]> {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('*')
      .eq('business_id', businessId)
      .eq('customer_id', customerId)
      .order('date', { ascending: false });

    if (error) {
      throw new Error('Error al obtener comprobantes del cliente');
    }

    return data || [];
  },
};
