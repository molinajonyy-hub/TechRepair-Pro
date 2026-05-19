import { supabase } from '../../lib/supabase'
import { personalService } from './personalService'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreditCard {
  id: string
  user_id: string
  business_id: string | null
  name: string
  issuer: string | null
  closing_day: number
  due_day: number
  credit_limit: number | null
  currency: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CardPurchase {
  id: string
  user_id: string
  credit_card_id: string
  category_id: string | null
  description: string
  total_amount: number
  installments: number
  purchase_date: string             // date 'YYYY-MM-DD'
  first_installment_month: string   // 'YYYY-MM'
  notes: string | null
  created_at: string
  updated_at: string
  // joined
  credit_card?: Pick<CreditCard, 'name' | 'issuer' | 'currency'>
  category?: { name: string; icon: string; color: string }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const creditCardService = {

  // ── Cards ─────────────────────────────────────────────────────────────────
  async getCreditCards(userId: string): Promise<CreditCard[]> {
    const { data, error } = await supabase
      .from('personal_credit_cards')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return (data ?? []) as CreditCard[]
  },

  async createCreditCard(
    userId: string,
    input: Pick<CreditCard, 'name' | 'issuer' | 'closing_day' | 'due_day' | 'credit_limit' | 'currency'>
  ): Promise<CreditCard> {
    const { data, error } = await supabase
      .from('personal_credit_cards')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    if (error) throw error
    return data as CreditCard
  },

  async updateCreditCard(
    id: string,
    userId: string,
    updates: Partial<Pick<CreditCard, 'name' | 'issuer' | 'closing_day' | 'due_day' | 'credit_limit' | 'currency' | 'is_active'>>
  ): Promise<void> {
    const { error } = await supabase
      .from('personal_credit_cards')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  async deactivateCreditCard(id: string, userId: string): Promise<void> {
    await creditCardService.updateCreditCard(id, userId, { is_active: false })
  },

  // ── Purchases ─────────────────────────────────────────────────────────────
  async getCardPurchases(userId: string, cardId?: string): Promise<CardPurchase[]> {
    let q = supabase
      .from('personal_card_purchases')
      .select('*, credit_card:personal_credit_cards(name,issuer,currency), category:personal_categories(name,icon,color)')
      .eq('user_id', userId)
      .order('purchase_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (cardId) q = q.eq('credit_card_id', cardId)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as CardPurchase[]
  },

  async createCardPurchase(
    userId: string,
    input: Pick<CardPurchase, 'credit_card_id' | 'category_id' | 'description' | 'total_amount' | 'installments' | 'purchase_date' | 'first_installment_month' | 'notes'>
  ): Promise<CardPurchase> {
    const { data, error } = await supabase
      .from('personal_card_purchases')
      .insert({ ...input, user_id: userId })
      .select()
      .single()
    if (error) throw error
    return data as CardPurchase
  },

  async deleteCardPurchase(id: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('personal_card_purchases')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
    if (error) throw error
  },

  // ── Payment ───────────────────────────────────────────────────────────────
  // Creates a personal expense transaction debiting the selected account.
  // Does NOT delete purchases — they remain as history/projection.
  async payCreditCard(
    userId: string,
    params: {
      cardName: string
      accountId: string
      amount: number
      date: string
      notes: string
      categoryId: string | null
    }
  ): Promise<void> {
    await personalService.createTransaction(userId, {
      account_id: params.accountId,
      category_id: params.categoryId,
      type: 'expense',
      amount: params.amount,
      currency: 'ARS',
      date: params.date,
      description: `Pago tarjeta ${params.cardName}`,
      notes: params.notes.trim() || null,
      payment_method: null,
      linked_owner_withdrawal_id: null,
    })
  },
}
