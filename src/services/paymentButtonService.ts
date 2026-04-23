import { supabase } from '../lib/supabase';
import type { PaymentButton } from './paymentCalculator';

export type { PaymentButton };

export type NewPaymentButton = Omit<PaymentButton, 'id' | 'created_at' | 'updated_at'>;

// ─── Service ──────────────────────────────────────────────────────────────────

export const paymentButtonService = {

  async getAll(businessId: string): Promise<PaymentButton[]> {
    const { data, error } = await supabase
      .from('payment_method_buttons')
      .select('*')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw error;
    return (data || []) as PaymentButton[];
  },

  async getActive(businessId: string): Promise<PaymentButton[]> {
    const { data, error } = await supabase
      .from('payment_method_buttons')
      .select('*')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return (data || []) as PaymentButton[];
  },

  async create(btn: NewPaymentButton): Promise<PaymentButton> {
    // Generar code único si no se provee
    if (!btn.code) {
      btn = { ...btn, code: slugify(btn.name) };
    }

    const { data, error } = await supabase
      .from('payment_method_buttons')
      .insert(btn)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data as PaymentButton;
  },

  async update(id: string, updates: Partial<NewPaymentButton>): Promise<PaymentButton> {
    const { data, error } = await supabase
      .from('payment_method_buttons')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data as PaymentButton;
  },

  async toggle(id: string, isActive: boolean): Promise<void> {
    const { error } = await supabase
      .from('payment_method_buttons')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw new Error(error.message);
  },

  async reorder(items: { id: string; sort_order: number }[]): Promise<void> {
    await Promise.all(
      items.map(({ id, sort_order }) =>
        supabase
          .from('payment_method_buttons')
          .update({ sort_order, updated_at: new Date().toISOString() })
          .eq('id', id)
      )
    );
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase
      .from('payment_method_buttons')
      .delete()
      .eq('id', id);

    if (error) throw new Error(error.message);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}
