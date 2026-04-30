import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommissionOption {
  id: string
  business_id: string
  group_id: string
  name: string
  percentage: number
  charge_mode: 'none' | 'customer' | 'business'
  is_active: boolean
  sort_order: number
}

export interface CommissionGroup {
  id: string
  business_id: string
  name: string
  slug?: string
  color: string
  is_active: boolean
  sort_order: number
  options: CommissionOption[]
}

// Método de cobro flat para usar en el selector de comprobante
export interface FlatPaymentMethod {
  id: string              // option id
  group_id: string
  label: string           // "MercadoPago — Débito"
  short_label: string     // "Débito"
  group_name: string      // "MercadoPago"
  percentage: number
  charge_mode: 'none' | 'customer' | 'business'
  color: string
}

// Fijos siempre disponibles (sin DB)
export const FIXED_METHODS: FlatPaymentMethod[] = [
  { id: 'efectivo',      group_id: '', label: 'Efectivo',      short_label: 'Efectivo',      group_name: 'Efectivo',      percentage: 0, charge_mode: 'none', color: '#34d399' },
  { id: 'transferencia', group_id: '', label: 'Transferencia', short_label: 'Transferencia', group_name: 'Transferencia', percentage: 0, charge_mode: 'none', color: '#60a5fa' },
]

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePaymentCommissions() {
  const { businessId } = useAuth()
  const [groups, setGroups] = useState<CommissionGroup[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    try {
      // Inicializar defaults si no hay grupos
      await supabase.rpc('seed_commission_defaults', { p_business_id: businessId }).then(() => {})

      const { data: grps } = await supabase
        .from('payment_commission_groups')
        .select('*')
        .eq('business_id', businessId)
        .order('sort_order')

      if (!grps?.length) { setGroups([]); return }

      const { data: opts } = await supabase
        .from('payment_commission_options')
        .select('*')
        .eq('business_id', businessId)
        .order('sort_order')

      const optMap: Record<string, CommissionOption[]> = {}
      for (const o of opts || []) {
        if (!optMap[o.group_id]) optMap[o.group_id] = []
        optMap[o.group_id].push(o as CommissionOption)
      }

      setGroups((grps as CommissionGroup[]).map(g => ({
        ...g, options: optMap[g.id] || [],
      })))
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => { load() }, [load])

  // Métodos activos como lista plana (para el selector de cobro)
  const flatMethods: FlatPaymentMethod[] = [
    ...FIXED_METHODS,
    ...groups
      .filter(g => g.is_active)
      .flatMap(g =>
        g.options
          .filter(o => o.is_active)
          .map(o => ({
            id: o.id,
            group_id: g.id,
            label: `${g.name} — ${o.name}`,
            short_label: o.name,
            group_name: g.name,
            percentage: o.percentage,
            charge_mode: o.charge_mode,
            color: g.color,
          }))
      ),
  ]

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  const createGroup = async (name: string, color: string) => {
    if (!businessId) return
    const maxOrder = Math.max(0, ...groups.map(g => g.sort_order)) + 1
    const { error } = await supabase.from('payment_commission_groups')
      .insert({ business_id: businessId, name, color, sort_order: maxOrder })
    if (!error) load()
  }

  const updateGroup = async (id: string, updates: Partial<Pick<CommissionGroup, 'name' | 'color' | 'is_active'>>) => {
    await supabase.from('payment_commission_groups').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id)
    load()
  }

  const deleteGroup = async (id: string) => {
    await supabase.from('payment_commission_groups').delete().eq('id', id)
    load()
  }

  const createOption = async (groupId: string, name: string, percentage: number, chargeMode: CommissionOption['charge_mode']) => {
    if (!businessId) return
    const group = groups.find(g => g.id === groupId)
    const maxOrder = Math.max(0, ...(group?.options || []).map(o => o.sort_order)) + 1
    await supabase.from('payment_commission_options')
      .insert({ business_id: businessId, group_id: groupId, name, percentage, charge_mode: chargeMode, sort_order: maxOrder })
    load()
  }

  const updateOption = async (id: string, updates: Partial<Pick<CommissionOption, 'name' | 'percentage' | 'charge_mode' | 'is_active'>>) => {
    await supabase.from('payment_commission_options').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id)
    load()
  }

  const deleteOption = async (id: string) => {
    await supabase.from('payment_commission_options').delete().eq('id', id)
    load()
  }

  return { groups, loading, flatMethods, reload: load, createGroup, updateGroup, deleteGroup, createOption, updateOption, deleteOption }
}
