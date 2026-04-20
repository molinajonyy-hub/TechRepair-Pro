import { supabase } from '../lib/supabase';

export interface Supplier {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  active: boolean;
  business_id: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export const suppliersService = {
  /**
   * Obtener todos los proveedores activos
   */
  async getActiveSuppliers(businessId: string): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('business_id', businessId)
      .eq('active', true)
      .order('name');

    if (error) {
      throw new Error('Error al obtener proveedores');
    }

    return data || [];
  },

  /**
   * Obtener todos los proveedores
   */
  async getAllSuppliers(businessId: string): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('business_id', businessId)
      .order('name');

    if (error) {
      throw new Error('Error al obtener proveedores');
    }

    return data || [];
  },

  /**
   * Obtener proveedor por ID
   */
  async getSupplierById(supplierId: string, businessId: string): Promise<Supplier | null> {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', supplierId)
      .eq('business_id', businessId)
      .single();

    if (error) {
      throw new Error('Error al obtener proveedor');
    }

    return data;
  },

  /**
   * Crear nuevo proveedor
   */
  async createSupplier(
    supplier: Omit<Supplier, 'id' | 'created_at' | 'updated_at'>,
    businessId: string,
    userId: string
  ): Promise<Supplier> {
    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        ...supplier,
        business_id: businessId,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al crear proveedor');
    }

    return data;
  },

  /**
   * Actualizar proveedor
   */
  async updateSupplier(
    supplierId: string,
    supplier: Partial<Omit<Supplier, 'id' | 'created_at' | 'updated_at'>>,
    businessId: string
  ): Promise<Supplier> {
    const { data, error } = await supabase
      .from('suppliers')
      .update(supplier)
      .eq('id', supplierId)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error || !data) {
      throw new Error('Error al actualizar proveedor');
    }

    return data;
  },

  /**
   * Desactivar proveedor
   */
  async deactivateSupplier(supplierId: string, businessId: string): Promise<void> {
    const { error } = await supabase
      .from('suppliers')
      .update({ active: false })
      .eq('id', supplierId)
      .eq('business_id', businessId);

    if (error) {
      throw new Error('Error al desactivar proveedor');
    }
  },

  /**
   * Buscar proveedores
   */
  async searchSuppliers(query: string, businessId: string): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('business_id', businessId)
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      .order('name');

    if (error) {
      throw new Error('Error al buscar proveedores');
    }

    return data || [];
  },
};
