import { useState, useEffect } from 'react'
import { Save, Loader2, CheckCircle, Percent } from 'lucide-react'
import { useCommissionRates, CommissionRates, DEFAULT_RATES } from '../../hooks/useCommissionRates'

interface RateFieldProps {
  label: string
  value: number
  onChange: (v: number) => void
  color: string
}

function RateField({ label, value, onChange, color }: RateFieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <label style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type="number"
          min={0}
          max={999}
          step={0.01}
          value={+(value * 100).toFixed(4)}
          onChange={e => onChange(+(+e.target.value / 100).toFixed(6))}
          style={{
            width: '100%',
            padding: '0.5rem 2.25rem 0.5rem 0.75rem',
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${color}40`,
            borderRadius: '0.5rem',
            color: '#f1f5f9',
            fontSize: '0.9rem',
            fontWeight: 600,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <Percent
          size={13}
          style={{ position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }}
        />
      </div>
    </div>
  )
}

interface GroupProps {
  title: string
  emoji: string
  color: string
  children: React.ReactNode
}

function Group({ title, emoji, color, children }: GroupProps) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: `1px solid ${color}25`,
      borderRadius: '0.875rem',
      padding: '1.25rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{ fontSize: '1.1rem' }}>{emoji}</span>
        <span style={{ fontWeight: 700, color: '#f1f5f9', fontSize: '0.9rem' }}>{title}</span>
        <span style={{
          marginLeft: 'auto',
          fontSize: '0.68rem', color: color,
          background: `${color}15`, border: `1px solid ${color}30`,
          borderRadius: '0.375rem', padding: '0.125rem 0.5rem', fontWeight: 600,
        }}>
          recargo al cliente
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.75rem' }}>
        {children}
      </div>
    </div>
  )
}

export function CommissionSettings() {
  const { rates, loading, saving, save } = useCommissionRates()
  const [local, setLocal] = useState<CommissionRates>(DEFAULT_RATES)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!loading) setLocal(rates)
  }, [loading, rates])

  const set = (key: keyof CommissionRates) => (v: number) =>
    setLocal(prev => ({ ...prev, [key]: v }))

  const handleSave = async () => {
    const ok = await save(local)
    if (ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: '#64748b' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h3 style={{ margin: '0 0 0.375rem', fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
          Recargos por método de pago
        </h3>
        <p style={{ margin: 0, fontSize: '0.82rem', color: '#64748b', lineHeight: 1.5 }}>
          Estos porcentajes se aplican automáticamente al cobrar con cada método. El total con recargo se refleja en el comprobante sin mostrar el detalle.
        </p>
      </div>

      <Group title="MercadoPago" emoji="💳" color="#009ee3">
        <RateField label="Débito" value={local.mercadopago_debito} onChange={set('mercadopago_debito')} color="#009ee3" />
        <RateField label="Crédito" value={local.mercadopago_credito} onChange={set('mercadopago_credito')} color="#009ee3" />
        <RateField label="QR" value={local.mercadopago_qr} onChange={set('mercadopago_qr')} color="#009ee3" />
      </Group>

      <Group title="Visa / Mastercard" emoji="💳" color="#1a56db">
        <RateField label="1 cuota" value={local.visa_mc_1} onChange={set('visa_mc_1')} color="#1a56db" />
        <RateField label="3 cuotas" value={local.visa_mc_3} onChange={set('visa_mc_3')} color="#1a56db" />
        <RateField label="6 cuotas" value={local.visa_mc_6} onChange={set('visa_mc_6')} color="#1a56db" />
        <RateField label="12 cuotas" value={local.visa_mc_12} onChange={set('visa_mc_12')} color="#1a56db" />
      </Group>

      <Group title="Naranja X" emoji="🟠" color="#f97316">
        <RateField label="1 cuota" value={local.naranja_1} onChange={set('naranja_1')} color="#f97316" />
        <RateField label="3 cuotas" value={local.naranja_3} onChange={set('naranja_3')} color="#f97316" />
        <RateField label="6 cuotas" value={local.naranja_6} onChange={set('naranja_6')} color="#f97316" />
        <RateField label="12 cuotas" value={local.naranja_12} onChange={set('naranja_12')} color="#f97316" />
      </Group>

      <div style={{
        padding: '0.875rem 1.125rem',
        background: 'rgba(34,197,94,0.05)',
        border: '1px solid rgba(34,197,94,0.15)',
        borderRadius: '0.75rem',
        fontSize: '0.8rem', color: '#64748b',
      }}>
        💵 <strong style={{ color: '#94a3b8' }}>Efectivo</strong> y{' '}
        <strong style={{ color: '#94a3b8' }}>Transferencia</strong> no tienen recargo.
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          alignSelf: 'flex-start',
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.625rem 1.25rem',
          background: saved ? 'rgba(34,197,94,0.15)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          border: saved ? '1px solid rgba(34,197,94,0.3)' : 'none',
          borderRadius: '0.625rem',
          color: saved ? '#4ade80' : '#fff',
          fontWeight: 600, fontSize: '0.875rem',
          cursor: saving ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s',
        }}
      >
        {saving ? (
          <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
        ) : saved ? (
          <><CheckCircle size={15} /> Guardado</>
        ) : (
          <><Save size={15} /> Guardar recargos</>
        )}
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
