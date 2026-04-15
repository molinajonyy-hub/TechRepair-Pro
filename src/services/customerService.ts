import { supabase } from '../lib/supabase';

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  business_id: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export const customerService = {
  /**
   * Obtener todos los clientes
   */
  async getAllCustomers(businessId: string): Promise<Customer[]> {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .order('name');

    if (error) {
      throw new Error('Error al obtener clientes');
    }

    return data || [];
  },

  /**
   * Obtener cliente por ID
   */
  async getCustomerById(customerId: string, businessId: string): Promise<Customer | null> {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .eq('business_id', businessId)
      .single();

    if (error) {
      throw new Error('Error al obtener cliente');
    }

    return data;
  },

  /**
   * Crear nuevo cliente
   */
  async createCustomer(
    customer: Omit<Customer, 'id' | 'created_at' | 'updated_at'>,
    businessId: string,
    userId: string
  ): Promise<Customer> {
    const { data, error } = await supabase
      .from('customers')
      .insert({
        ...customer,
        business_id: businessId,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al crear cliente');
    }

    return data;
  },

  /**
   * Actualizar cliente
   */
  async updateCustomer(
    customerId: string,
    customer: Partial<Omit<Customer, 'id' | 'created_at' | 'updated_at'>>,
    businessId: string
  ): Promise<Customer> {
    const { data, error } = await supabase
      .from('customers')
      .update(customer)
      .eq('id', customerId)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al actualizar cliente');
    }

    return data;
  },

  /**
   * Buscar clientes
   */
  async searchCustomers(query: string, businessId: string): Promise<Customer[]> {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      .order('name');

    if (error) {
      throw new Error('Error al buscar clientes');
    }

    return data || [];
  },
};
