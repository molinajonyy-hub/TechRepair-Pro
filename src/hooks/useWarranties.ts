import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// ─── Tipos ────────────────────────────────────────────────────────────

export type EquipmentStatus = 'new' | 'used'

// ── Extensiones postventa ─────────────────────────────────────────────

export type WarrantySource =
  | 'sold_device'       // equipo vendido (legacy)
  | 'service_order'     // reparación/servicio
  | 'comprobante_item'  // producto/accesorio de un comprobante
  | 'product_sale'      // venta directa de producto
  | 'manual'            // creada manualmente sin origen específico

export type WarrantyType =
  | 'sold_device' | 'repair' | 'screen' | 'battery'
  | 'service' | 'accessory' | 'product' | 'custom'

export type WarrantyStoredStatus = 'open' | 'claimed' | 'resolved' | 'voided'

export type WarrantyEventType =
  | 'created' | 'claimed' | 'note_added' | 'resolved' | 'voided' | 'extended'

export interface WarrantyEvent {
  id: string
  warranty_id: string
  business_id: string
  event_type: WarrantyEventType
  notes: string | null
  created_by: string | null
  created_at: string
}

export const WARRANTY_SOURCE_LABELS: Record<WarrantySource, string> = {
  sold_device:      'Equipo vendido',
  service_order:    'Reparación',
  comprobante_item: 'Comprobante',
  product_sale:     'Venta producto',
  manual:           'Manual',
}

export const WARRANTY_TYPE_LABELS: Record<WarrantyType, string> = {
  sold_device: 'Equipo vendido',
  repair:      'Reparación general',
  screen:      'Cambio de pantalla',
  battery:     'Cambio de batería',
  service:     'Servicio técnico',
  accessory:   'Accesorio',
  product:     'Producto',
  custom:      'Personalizada',
}

export const WARRANTY_TYPE_DEFAULT_DAYS: Record<WarrantyType, number> = {
  sold_device: 90,
  repair:      30,
  screen:      60,
  battery:     90,
  service:     30,
  accessory:   30,
  product:     90,
  custom:      30,
}

// Claves canónicas del checklist (en inglés para no cambiar si se traduce)
export const CHECKLIST_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'powers_on',          label: 'Enciende correctamente' },
  { key: 'screen',             label: 'Pantalla funciona correctamente' },
  { key: 'touch',              label: 'Táctil funciona correctamente' },
  { key: 'biometrics',         label: 'Face ID / Huella funciona' },
  { key: 'cameras',            label: 'Cámaras funcionan' },
  { key: 'earpiece',           label: 'Parlante auricular funciona' },
  { key: 'loudspeaker',        label: 'Parlante altavoz funciona' },
  { key: 'microphone',         label: 'Micrófono funciona' },
  { key: 'charging_port',      label: 'Puerto de carga funciona' },
  { key: 'charging',           label: 'Carga correctamente' },
  { key: 'buttons',            label: 'Botones funcionan' },
  { key: 'wifi',               label: 'WiFi funciona' },
  { key: 'bluetooth',          label: 'Bluetooth funciona' },
  { key: 'mobile_network',     label: 'Red móvil funciona' },
  { key: 'battery',            label: 'Batería en funcionamiento normal' },
  { key: 'imei_matches',       label: 'IMEI coincide con el equipo' },
  { key: 'no_locks',           label: 'Equipo libre de cuentas / bloqueos' },
  { key: 'restored',           label: 'Equipo restaurado / configurado' },
  { key: 'no_visible_issues',  label: 'Sin fallas visibles' },
]

export type WarrantyChecklist = Record<string, boolean>

export interface Warranty {
  id: string
  business_id: string
  number: string
  issue_date: string            // 'YYYY-MM-DD'
  customer_name: string
  customer_dni?: string | null
  customer_phone?: string | null
  phone_model: string           // equipo/producto/servicio (campo reutilizado para compatibilidad)
  imei?: string | null
  serial_number?: string | null
  supplier_id?: string | null
  warranty_days: number
  equipment_status: EquipmentStatus
  purchase_date?: string | null
  checklist: WarrantyChecklist
  observations?: string | null
  conditions?: string | null
  attended_by_user_id?: string | null
  attended_by_name?: string | null
  is_active: boolean
  created_by?: string | null
  created_at: string
  updated_at: string
  // ── Extensiones postventa (nullable — legacy rows = null / 'sold_device') ──
  warranty_source?: WarrantySource | null
  warranty_type?: WarrantyType | null
  order_id?: string | null
  comprobante_id?: string | null
  comprobante_item_id?: string | null
  inventory_id?: string | null
  customer_id?: string | null
  item_description?: string | null
  warranty_status?: WarrantyStoredStatus | null
  claim_notes?: string | null
  void_reason?: string | null
  resolved_at?: string | null
}

export type WarrantyInput = Omit<
  Warranty,
  'id' | 'business_id' | 'is_active' | 'created_by' | 'created_at' | 'updated_at' | 'number'
> & {
  // number opcional al crear: se autogenera si falta
  number?: string
}

// Estado calculado a partir de issue_date + warranty_days
export type WarrantyStatus = 'active' | 'expiring_soon' | 'expired'

export const DEFAULT_WARRANTY_CONDITIONS = [
  '• No cubre golpes ni daños por humedad.',
  '• No cubre daños por mal uso o manipulación inadecuada.',
  '• No cubre software modificado (jailbreak, root, flasheos).',
  '• En equipos usados la garantía aplica sobre las condiciones informadas al momento de la venta.',
].join('\n')

export const DEFAULT_OBSERVATIONS = 'Equipo verificado y entregado en correcto funcionamiento.'

// ─── Helpers de estado/vencimiento ────────────────────────────────────

export function computeExpiryDate(issueDate: string, days: number): string {
  const d = new Date(issueDate + 'T00:00:00')
  d.setDate(d.getDate() + (days || 0))
  return d.toISOString().slice(0, 10)
}

export function computeWarrantyStatus(
  issueDate: string,
  days: number,
  today: Date = new Date()
): { status: WarrantyStatus; expiryDate: string; daysRemaining: number } {
  const expiryDate = computeExpiryDate(issueDate, days)
  const expiry = new Date(expiryDate + 'T00:00:00')
  const base = new Date(today.toISOString().slice(0, 10) + 'T00:00:00')
  const daysRemaining = Math.round((expiry.getTime() - base.getTime()) / 86400000)

  let status: WarrantyStatus = 'active'
  if (daysRemaining < 0) status = 'expired'
  else if (daysRemaining <= 7) status = 'expiring_soon'

  return { status, expiryDate, daysRemaining }
}

// Normaliza errores (PostgrestError plano → Error con code/details preservados)
function toError(err: unknown): Error {
  if (err instanceof Error) return err
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>
    const message = typeof anyErr.message === 'string' && anyErr.message
      ? anyErr.message
      : 'Error desconocido'
    const wrapped = new Error(message)
    if (typeof anyErr.code !== 'undefined') (wrapped as any).code = anyErr.code
    if (typeof anyErr.details !== 'undefined') (wrapped as any).details = anyErr.details
    if (typeof anyErr.hint !== 'undefined') (wrapped as any).hint = anyErr.hint
    return wrapped
  }
  if (typeof err === 'string' && err) return new Error(err)
  return new Error('Error desconocido')
}

// ─── Hook ─────────────────────────────────────────────────────────────

export function useWarranties() {
  const { businessId, user, profile } = useAuth()
  const [items, setItems] = useState<Warranty[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadWarranties = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background === true
    try {
      if (!background) setLoading(true)
      setError(null)

      let query = supabase
        .from('warranties')
        .select('*')
        .eq('is_active', true)
        .order('issue_date', { ascending: false })
        .order('created_at', { ascending: false })

      if (businessId) query = query.eq('business_id', businessId)

      const { data, error: fetchError } = await query
      if (fetchError) throw fetchError
      setItems((data || []) as Warranty[])
    } catch (err: unknown) {
      const e = toError(err)
      setError(e.message || 'Error al cargar garantías')
    } finally {
      if (!background) setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    void loadWarranties()
  }, [loadWarranties])

  const getNextNumber = useCallback(async (): Promise<string> => {
    if (!businessId) throw new Error('No hay business_id activo')
    const { data, error: rpcError } = await supabase.rpc('generar_numero_garantia', {
      p_business_id: businessId,
    })
    if (rpcError) throw toError(rpcError)
    return (data as string) || 'GAR-000001'
  }, [businessId])

  const addWarranty = useCallback(
    async (input: WarrantyInput, options?: { skipReload?: boolean }) => {
      try {
        // Autogenerar número si no viene
        const number = input.number || (await getNextNumber())

        const payload = {
          ...input,
          number,
          business_id: businessId,
          created_by: user?.id,
          attended_by_user_id: input.attended_by_user_id ?? user?.id ?? null,
          attended_by_name:
            input.attended_by_name ??
            profile?.full_name ??
            profile?.email ??
            null,
          // Si es "new", asegurar que no quede purchase_date colgada
          purchase_date:
            input.equipment_status === 'used' ? input.purchase_date ?? null : null,
        }

        const { data, error: insertError } = await supabase
          .from('warranties')
          .insert(payload)
          .select()
          .single()

        if (insertError) throw insertError
        if (!options?.skipReload) await loadWarranties({ background: true })
        return data as Warranty
      } catch (err: unknown) {
        throw toError(err)
      }
    },
    [businessId, user?.id, profile?.full_name, profile?.email, getNextNumber, loadWarranties]
  )

  const updateWarranty = useCallback(
    async (id: string, updates: Partial<Warranty>, options?: { skipReload?: boolean }) => {
      try {
        const patched: Partial<Warranty> = { ...updates }
        if (patched.equipment_status === 'new') {
          patched.purchase_date = null
        }

        let query = supabase.from('warranties').update(patched).eq('id', id)
        if (businessId) query = query.eq('business_id', businessId)

        const { error: updateError } = await query
        if (updateError) throw updateError
        if (!options?.skipReload) await loadWarranties({ background: true })
      } catch (err: unknown) {
        throw toError(err)
      }
    },
    [businessId, loadWarranties]
  )

  const deleteWarranty = useCallback(
    async (id: string) => {
      try {
        let query = supabase.from('warranties').update({ is_active: false }).eq('id', id)
        if (businessId) query = query.eq('business_id', businessId)
        const { error: deleteError } = await query
        if (deleteError) throw deleteError
        await loadWarranties({ background: true })
      } catch (err: unknown) {
        throw toError(err)
      }
    },
    [businessId, loadWarranties]
  )

  const addWarrantyEvent = useCallback(
    async (warrantyId: string, eventType: WarrantyEventType, notes?: string) => {
      if (!businessId) throw new Error('No hay business_id activo')
      const { error: evtErr } = await supabase.from('warranty_events').insert({
        warranty_id: warrantyId,
        business_id: businessId,
        event_type:  eventType,
        notes:       notes ?? null,
        created_by:  user?.id ?? null,
      })
      if (evtErr) throw toError(evtErr)
    },
    [businessId, user?.id]
  )

  const getWarrantyEvents = useCallback(
    async (warrantyId: string): Promise<WarrantyEvent[]> => {
      const { data, error: fetchErr } = await supabase
        .from('warranty_events')
        .select('*')
        .eq('warranty_id', warrantyId)
        .order('created_at', { ascending: false })
      if (fetchErr) throw toError(fetchErr)
      return (data || []) as WarrantyEvent[]
    },
    []
  )

  return {
    items,
    loading,
    error,
    refresh: loadWarranties,
    getNextNumber,
    addWarranty,
    updateWarranty,
    deleteWarranty,
    addWarrantyEvent,
    getWarrantyEvents,
  }
}
