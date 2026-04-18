import { useEffect, useMemo, useState } from 'react'
import { X, Save, Printer, Check } from 'lucide-react'
import {
  CHECKLIST_ITEMS,
  DEFAULT_OBSERVATIONS,
  DEFAULT_WARRANTY_CONDITIONS,
  EquipmentStatus,
  Warranty,
  WarrantyChecklist,
  WarrantyInput,
  computeExpiryDate,
} from '../../hooks/useWarranties'
import { useAuth } from '../../contexts/AuthContext'
import { suppliersService, Supplier } from '../../services/suppliersService'

interface WarrantyFormModalProps {
  open: boolean
  onClose: () => void
  onSave: (input: WarrantyInput) => Promise<Warranty | void>
  onSaveAndPrint?: (input: WarrantyInput) => Promise<void>
  /** Si se pasa, estamos editando esa garantía (la creación se determina por !editing) */
  editing?: Warranty | null
  /**
   * Si se pasa (y NO hay editing), el form se pre-carga con estos valores
   * pero se trata como una creación nueva (útil para "duplicar").
   */
  prefill?: Warranty | null
}

// ─── Estilos comunes ─────────────────────────────────────────────────────────

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: '#94a3b8',
  marginBottom: '0.375rem',
  fontWeight: 500,
  letterSpacing: '0.01em',
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  backgroundColor: 'rgba(15,23,42,0.8)',
  border: '1px solid rgba(51,65,85,0.6)',
  borderRadius: '0.5rem',
  color: '#f1f5f9',
  outline: 'none',
  fontSize: '0.875rem',
  boxSizing: 'border-box',
}

const textarea: React.CSSProperties = {
  ...input,
  minHeight: '80px',
  resize: 'vertical',
  fontFamily: 'inherit',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyChecklist(): WarrantyChecklist {
  return CHECKLIST_ITEMS.reduce<WarrantyChecklist>((acc, it) => {
    acc[it.key] = false
    return acc
  }, {})
}

function fullChecklist(): WarrantyChecklist {
  return CHECKLIST_ITEMS.reduce<WarrantyChecklist>((acc, it) => {
    acc[it.key] = true
    return acc
  }, {})
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function WarrantyFormModal({
  open,
  onClose,
  onSave,
  onSaveAndPrint,
  editing = null,
  prefill = null,
}: WarrantyFormModalProps) {
  const { businessId, profile, user } = useAuth()

  const [saving, setSaving] = useState(false)
  const [savingAndPrint, setSavingAndPrint] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loadingSuppliers, setLoadingSuppliers] = useState(false)

  // ── Estado del form
  const [issueDate, setIssueDate] = useState<string>(todayISO())
  const [customerName, setCustomerName] = useState('')
  const [customerDni, setCustomerDni] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [phoneModel, setPhoneModel] = useState('')
  const [imei, setImei] = useState('')
  const [serial, setSerial] = useState('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [warrantyDays, setWarrantyDays] = useState<number>(30)
  const [equipmentStatus, setEquipmentStatus] = useState<EquipmentStatus>('new')
  const [purchaseDate, setPurchaseDate] = useState<string>('')
  const [checklist, setChecklist] = useState<WarrantyChecklist>(fullChecklist())
  const [observations, setObservations] = useState(DEFAULT_OBSERVATIONS)
  const [conditions, setConditions] = useState(DEFAULT_WARRANTY_CONDITIONS)
  const [attendedByName, setAttendedByName] = useState('')

  // ── Cargar proveedores cuando se abre
  useEffect(() => {
    if (!open || !businessId) return
    let cancelled = false
    setLoadingSuppliers(true)
    suppliersService
      .getActiveSuppliers(businessId)
      .then((data) => {
        if (!cancelled) setSuppliers(data || [])
      })
      .catch(() => {
        if (!cancelled) setSuppliers([])
      })
      .finally(() => {
        if (!cancelled) setLoadingSuppliers(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, businessId])

  // ── Inicializar desde "editing" / "prefill" o resetear en create
  useEffect(() => {
    if (!open) return
    const seed = editing || prefill
    if (seed) {
      // Si es duplicado (no hay editing), usamos la fecha de hoy en lugar de la original
      setIssueDate(editing ? seed.issue_date || todayISO() : todayISO())
      setCustomerName(seed.customer_name || '')
      setCustomerDni(seed.customer_dni || '')
      setCustomerPhone(seed.customer_phone || '')
      setPhoneModel(seed.phone_model || '')
      setImei(seed.imei || '')
      setSerial(seed.serial_number || '')
      setSupplierId(seed.supplier_id || '')
      setWarrantyDays(seed.warranty_days ?? 30)
      setEquipmentStatus(seed.equipment_status || 'new')
      setPurchaseDate(seed.purchase_date || '')
      setChecklist({ ...(seed.checklist || emptyChecklist()) })
      setObservations(seed.observations ?? DEFAULT_OBSERVATIONS)
      setConditions(seed.conditions ?? DEFAULT_WARRANTY_CONDITIONS)
      setAttendedByName(
        editing
          ? seed.attended_by_name || ''
          : profile?.full_name || profile?.email || ''
      )
    } else {
      setIssueDate(todayISO())
      setCustomerName('')
      setCustomerDni('')
      setCustomerPhone('')
      setPhoneModel('')
      setImei('')
      setSerial('')
      setSupplierId('')
      setWarrantyDays(30)
      setEquipmentStatus('new')
      setPurchaseDate('')
      setChecklist(fullChecklist())
      setObservations(DEFAULT_OBSERVATIONS)
      setConditions(DEFAULT_WARRANTY_CONDITIONS)
      setAttendedByName(profile?.full_name || profile?.email || '')
    }
    setError(null)
  }, [open, editing, prefill, profile?.full_name, profile?.email])

  // ── Cálculo de vencimiento
  const expiryDate = useMemo(() => {
    if (!issueDate) return ''
    return computeExpiryDate(issueDate, warrantyDays)
  }, [issueDate, warrantyDays])

  // ── Toggle checklist
  const toggleAll = (value: boolean) => {
    setChecklist(
      CHECKLIST_ITEMS.reduce<WarrantyChecklist>((acc, it) => {
        acc[it.key] = value
        return acc
      }, {})
    )
  }

  // ── Validación y armado del payload
  const buildPayload = (): WarrantyInput | null => {
    if (!customerName.trim()) {
      setError('Nombre del cliente es obligatorio')
      return null
    }
    if (!phoneModel.trim()) {
      setError('Modelo del equipo es obligatorio')
      return null
    }
    if (!warrantyDays || warrantyDays <= 0) {
      setError('Los días de garantía deben ser mayores a 0')
      return null
    }
    if (equipmentStatus === 'used' && !purchaseDate) {
      setError('Debe ingresar la fecha de compra para equipos usados')
      return null
    }

    const payload: WarrantyInput = {
      issue_date: issueDate,
      customer_name: customerName.trim(),
      customer_dni: customerDni.trim() || null,
      customer_phone: customerPhone.trim() || null,
      phone_model: phoneModel.trim(),
      imei: imei.trim() || null,
      serial_number: serial.trim() || null,
      supplier_id: supplierId || null,
      warranty_days: warrantyDays,
      equipment_status: equipmentStatus,
      purchase_date: equipmentStatus === 'used' ? purchaseDate || null : null,
      checklist: { ...checklist },
      observations: observations.trim() || null,
      conditions: conditions.trim() || null,
      attended_by_user_id: editing
        ? editing.attended_by_user_id ?? user?.id ?? null
        : user?.id ?? null,
      attended_by_name:
        attendedByName.trim() ||
        profile?.full_name ||
        profile?.email ||
        null,
    }
    return payload
  }

  const handleSave = async () => {
    const payload = buildPayload()
    if (!payload) return
    setSaving(true)
    setError(null)
    try {
      await onSave(payload)
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Error al guardar la garantía')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAndPrint = async () => {
    if (!onSaveAndPrint) return handleSave()
    const payload = buildPayload()
    if (!payload) return
    setSavingAndPrint(true)
    setError(null)
    try {
      await onSaveAndPrint(payload)
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Error al guardar la garantía')
    } finally {
      setSavingAndPrint(false)
    }
  }

  if (!open) return null

  const busy = saving || savingAndPrint

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 80,
        padding: '1rem',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          backgroundColor: '#0b1120',
          borderRadius: '1rem',
          border: '1px solid rgba(255,255,255,0.08)',
          width: '100%',
          maxWidth: '960px',
          maxHeight: '92vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '1.1rem 1.5rem',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
              {editing
                ? `Editar garantía ${editing.number}`
                : prefill
                ? `Nueva garantía (duplicada de ${prefill.number || '—'})`
                : 'Nueva garantía'}
            </h2>
            <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
              Completá los datos del cliente y el equipo. Las condiciones y el checklist pueden
              editarse.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              width: '36px',
              height: '36px',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '0.5rem',
              color: '#94a3b8',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {/* Fila 1 — Fecha + días + estado */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <div>
              <label style={label}>Fecha de emisión *</label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                style={input}
              />
            </div>
            <div>
              <label style={label}>Días de garantía *</label>
              <input
                type="number"
                min={1}
                value={warrantyDays}
                onChange={(e) => setWarrantyDays(Number(e.target.value) || 0)}
                style={input}
              />
            </div>
            <div>
              <label style={label}>Vencimiento</label>
              <input type="text" value={expiryDate || ''} readOnly style={{ ...input, opacity: 0.7 }} />
            </div>
            <div>
              <label style={label}>Condición del equipo *</label>
              <select
                value={equipmentStatus}
                onChange={(e) => setEquipmentStatus(e.target.value as EquipmentStatus)}
                style={input}
              >
                <option value="new">Nuevo</option>
                <option value="used">Usado</option>
              </select>
            </div>
          </div>

          {equipmentStatus === 'used' && (
            <div style={{ marginBottom: '1rem' }}>
              <label style={label}>Fecha de compra (equipo usado) *</label>
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                style={{ ...input, maxWidth: '260px' }}
              />
            </div>
          )}

          {/* Cliente */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <div>
              <label style={label}>Cliente *</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Nombre y apellido"
                style={input}
              />
            </div>
            <div>
              <label style={label}>DNI</label>
              <input
                type="text"
                value={customerDni}
                onChange={(e) => setCustomerDni(e.target.value)}
                placeholder="DNI"
                style={input}
              />
            </div>
            <div>
              <label style={label}>Teléfono</label>
              <input
                type="text"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="Teléfono"
                style={input}
              />
            </div>
          </div>

          {/* Equipo */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <div>
              <label style={label}>Modelo del equipo *</label>
              <input
                type="text"
                value={phoneModel}
                onChange={(e) => setPhoneModel(e.target.value)}
                placeholder="Ej: iPhone 13 128GB"
                style={input}
              />
            </div>
            <div>
              <label style={label}>IMEI</label>
              <input
                type="text"
                value={imei}
                onChange={(e) => setImei(e.target.value)}
                placeholder="IMEI"
                style={input}
              />
            </div>
            <div>
              <label style={label}>Serial</label>
              <input
                type="text"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="Nº de serie"
                style={input}
              />
            </div>
          </div>

          {/* Proveedor + atendido por */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <div>
              <label style={label}>
                Proveedor (interno — no se imprime){' '}
                {loadingSuppliers && <span style={{ color: '#64748b' }}>· cargando…</span>}
              </label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                style={input}
              >
                <option value="">— Sin proveedor —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={label}>Atendido por</label>
              <input
                type="text"
                value={attendedByName}
                onChange={(e) => setAttendedByName(e.target.value)}
                placeholder="Nombre del usuario"
                style={input}
              />
            </div>
          </div>

          {/* Checklist */}
          <div
            style={{
              padding: '1rem',
              backgroundColor: 'rgba(15,23,42,0.5)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.625rem',
              marginBottom: '1rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.75rem',
              }}
            >
              <span style={{ color: '#f1f5f9', fontWeight: 600 }}>
                Checklist de verificación (19 ítems)
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => toggleAll(true)}
                  style={{
                    padding: '0.3rem 0.75rem',
                    fontSize: '0.75rem',
                    background: 'rgba(99,102,241,0.2)',
                    border: '1px solid rgba(99,102,241,0.4)',
                    color: '#a5b4fc',
                    borderRadius: '0.375rem',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  Marcar todos
                </button>
                <button
                  type="button"
                  onClick={() => toggleAll(false)}
                  style={{
                    padding: '0.3rem 0.75rem',
                    fontSize: '0.75rem',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#94a3b8',
                    borderRadius: '0.375rem',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  Desmarcar todos
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                gap: '0.4rem 0.75rem',
              }}
            >
              {CHECKLIST_ITEMS.map((it) => {
                const checked = !!checklist[it.key]
                return (
                  <label
                    key={it.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '0.375rem',
                      cursor: 'pointer',
                      background: checked ? 'rgba(34,197,94,0.08)' : 'transparent',
                      border: checked
                        ? '1px solid rgba(34,197,94,0.3)'
                        : '1px solid rgba(255,255,255,0.04)',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setChecklist((prev) => ({ ...prev, [it.key]: e.target.checked }))
                      }
                      style={{ accentColor: '#22c55e' }}
                    />
                    <span
                      style={{
                        fontSize: '0.8125rem',
                        color: checked ? '#d1fae5' : '#cbd5e1',
                      }}
                    >
                      {it.label}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Observaciones + condiciones */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.75rem',
              marginBottom: '0.5rem',
            }}
          >
            <div>
              <label style={label}>Observaciones</label>
              <textarea
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                style={textarea}
              />
            </div>
            <div>
              <label style={label}>Condiciones de la garantía (editable)</label>
              <textarea
                value={conditions}
                onChange={(e) => setConditions(e.target.value)}
                style={{ ...textarea, minHeight: '120px' }}
              />
            </div>
          </div>

          {error && (
            <div
              style={{
                marginTop: '0.75rem',
                padding: '0.6rem 0.75rem',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#fca5a5',
                borderRadius: '0.5rem',
                fontSize: '0.8125rem',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '1rem 1.5rem',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '0.55rem 1.1rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.5rem',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: '0.875rem',
            }}
          >
            Cancelar
          </button>
          {onSaveAndPrint && (
            <button
              onClick={handleSaveAndPrint}
              disabled={busy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.55rem 1.1rem',
                background: 'rgba(99,102,241,0.15)',
                border: '1px solid rgba(99,102,241,0.35)',
                color: '#a5b4fc',
                borderRadius: '0.5rem',
                cursor: busy ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: '0.875rem',
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Printer size={16} />
              {savingAndPrint ? 'Guardando…' : 'Guardar e imprimir'}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={busy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.55rem 1.25rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.5rem',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {saving ? <Check size={16} /> : <Save size={16} />}
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear garantía'}
          </button>
        </div>
      </div>
    </div>
  )
}
