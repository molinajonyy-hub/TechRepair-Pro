import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

export interface CommissionRates {
  mercadopago_debito: number
  mercadopago_credito: number
  mercadopago_qr: number
  visa_mc_1: number
  visa_mc_3: number
  visa_mc_6: number
  visa_mc_12: number
  naranja_1: number
  naranja_3: number
  naranja_6: number
  naranja_12: number
}

export const COMMISSION_KEYS: Partial<Record<string, keyof CommissionRates>> = {
  mp_debito:   'mercadopago_debito',
  mp_credito:  'mercadopago_credito',
  mp_qr:       'mercadopago_qr',
  visa_mc_1:   'visa_mc_1',
  visa_mc_3:   'visa_mc_3',
  visa_mc_6:   'visa_mc_6',
  visa_mc_12:  'visa_mc_12',
  naranja_1:   'naranja_1',
  naranja_3:   'naranja_3',
  naranja_6:   'naranja_6',
  naranja_12:  'naranja_12',
}

export const DEFAULT_RATES: CommissionRates = {
  mercadopago_debito: 0.0089,
  mercadopago_credito: 0.0399,
  mercadopago_qr: 0.0099,
  visa_mc_1: 0.10,
  visa_mc_3: 0.221,
  visa_mc_6: 0.418,
  visa_mc_12: 0.953,
  naranja_1: 0.10,
  naranja_3: 0.228,
  naranja_6: 0.51,
  naranja_12: 0.87,
}

export function useCommissionRates() {
  const { businessId } = useAuth()
  const [rates, setRates] = useState<CommissionRates>(DEFAULT_RATES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!businessId) return
    supabase
      .from('business_settings')
      .select('commission_rates')
      .eq('business_id', businessId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.commission_rates && Object.keys(data.commission_rates).length > 0) {
          setRates({ ...DEFAULT_RATES, ...data.commission_rates })
        }
        setLoading(false)
      })
  }, [businessId])

  const save = useCallback(async (newRates: CommissionRates): Promise<boolean> => {
    if (!businessId) return false
    setSaving(true)
    try {
      const { error } = await supabase
        .from('business_settings')
        .update({ commission_rates: newRates })
        .eq('business_id', businessId)
      if (error) throw error
      setRates(newRates)
      return true
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }, [businessId])

  return { rates, loading, saving, save }
}
