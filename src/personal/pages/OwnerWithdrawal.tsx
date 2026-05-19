import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalAccount } from '../services/personalService'
import {
  PersonalLoading, PageContainer, PrimaryBtn, PersonalInput,
  PersonalSelect, showToast, fmtMoney,
} from '../components/ui'
import { logger } from '../../lib/logger'

const today = () => new Date().toISOString().split('T')[0]

export function OwnerWithdrawalPage() {
  const { user, businessId } = useAuth()
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<PersonalAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  const [amount, setAmount] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [date, setDate] = useState(today())
  const [notes, setNotes] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!user) return
    personalService.getAccounts(user.id)
      .then(data => { setAccounts(data); if (data.length) setDestinationId(data[0].id) })
      .finally(() => setLoading(false))
  }, [user])

  const amt = parseFloat(amount.replace(',', '.'))
  const isValid = amt > 0 && !!destinationId && !!date

  const handleConfirm = async () => {
    if (!user || !businessId || saving) {
      if (!businessId) setError('No hay negocio activo. Iniciá sesión en TechRepair Pro primero.')
      return
    }
    if (!isValid) { setError('Completá todos los campos requeridos'); return }
    setError('')
    setSaving(true)
    try {
      await personalService.registerOwnerWithdrawal({
        businessId,
        amount: amt,
        date,
        destinationAccountId: destinationId,
        notes: notes.trim(),
      })
      showToast({ message: `Retiro de ${fmtMoney(amt)} registrado`, type: 'success' })
      setSuccess(true)
    } catch (e: any) {
      logger.error('PERSONAL', 'registerWithdrawal', e)
      const msg = e.message || 'Error al registrar el retiro'
      setError(msg)
      showToast({ message: msg, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <PersonalLoading />

  if (success) {
    const destAccount = accounts.find(a => a.id === destinationId)
    return (
      <PageContainer testId="personal-salary-success">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem', padding: '2rem 0.5rem', textAlign: 'center' }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(52,211,153,0.12)', border: '2px solid rgba(52,211,153,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle2 size={36} color="#34d399" />
          </div>
          <div>
            <div style={{ fontSize: '1.375rem', fontWeight: 900, color: '#f0f4ff', letterSpacing: '-0.02em' }}>Retiro registrado</div>
            <div style={{ color: '#475569', fontSize: '0.875rem', marginTop: '0.375rem' }}>El movimiento quedó registrado en ambos lados</div>
          </div>

          <div style={{ width: '100%', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '1rem', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#334155', fontSize: '0.8rem' }}>Monto</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 800, color: '#34d399', fontSize: '1.25rem' }}>{fmtMoney(amt)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#334155', fontSize: '0.8rem' }}>Destino</span>
              <span style={{ color: '#f0f4ff', fontWeight: 600, fontSize: '0.875rem' }}>{destAccount?.name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#334155', fontSize: '0.8rem' }}>Fecha</span>
              <span style={{ color: '#f0f4ff', fontSize: '0.875rem' }}>{new Date(date + 'T12:00:00').toLocaleDateString('es-AR')}</span>
            </div>
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <Building2 size={14} color="#818cf8" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
              <div style={{ fontSize: '0.75rem', color: '#475569' }}>
                Registrado como <strong style={{ color: '#818cf8' }}>egreso del negocio</strong> · Retiro de propietario
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <ArrowRight size={14} color="#34d399" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
              <div style={{ fontSize: '0.75rem', color: '#475569' }}>
                Registrado como <strong style={{ color: '#34d399' }}>ingreso personal</strong> en {destAccount?.name}
              </div>
            </div>
          </div>

          <PrimaryBtn onClick={() => navigate('/personal')} fullWidth>
            Volver al inicio
          </PrimaryBtn>
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer testId="personal-salary-page">
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
          <div style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(129,140,248,0.15)', border: '1px solid rgba(129,140,248,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Building2 size={18} color="#818cf8" />
          </div>
          <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Pagarme sueldo / Retiro</span>
        </div>
        <div style={{ fontSize: '0.8rem', color: '#334155', marginTop: '0.375rem', lineHeight: 1.5 }}>
          Transferí plata desde el negocio a tu bolsillo personal. Queda registrado como egreso del negocio e ingreso personal.
        </div>
      </div>

      {/* Info banner */}
      <div style={{ padding: '0.875rem', background: 'rgba(129,140,248,0.06)', border: '1px solid rgba(129,140,248,0.15)', borderRadius: '0.875rem', display: 'flex', gap: '0.625rem', alignItems: 'flex-start' }}>
        <AlertCircle size={15} color="#818cf8" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
        <div style={{ fontSize: '0.775rem', color: '#475569', lineHeight: 1.5 }}>
          Esta acción registra el movimiento en <strong style={{ color: '#818cf8' }}>Finanzas del negocio</strong> como egreso y en <strong style={{ color: '#34d399' }}>Mi Guita</strong> como ingreso. Ambos quedan vinculados.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Amount — large display, font size already > 16px */}
        <div>
          <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.375rem' }}>Monto a retirar *</label>
          <input
            data-testid="personal-salary-amount"
            type="number" min="0" step="1" value={amount}
            onChange={e => { setAmount(e.target.value); setConfirmed(false) }}
            placeholder="0" autoFocus
            style={{ width: '100%', padding: '0.875rem', boxSizing: 'border-box', background: 'rgba(129,140,248,0.05)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: '0.875rem', color: '#818cf8', fontSize: '2rem', fontWeight: 900, outline: 'none', fontFamily: 'monospace', textAlign: 'right' }}
          />
        </div>

        <PersonalSelect
          testId="personal-salary-account"
          label="Cuenta destino (personal) *"
          value={destinationId}
          onChange={e => setDestinationId(e.target.value)}
        >
          <option value="">Seleccionar cuenta</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({fmtMoney(a.current_balance)})</option>)}
        </PersonalSelect>

        {accounts.length === 0 && (
          <div style={{ padding: '0.75rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.75rem', fontSize: '0.8rem', color: '#f59e0b' }}>
            No tenés cuentas personales. Creá una primero desde "Mis cuentas".
          </div>
        )}

        <PersonalInput label="Fecha" type="date" value={date} onChange={e => setDate(e.target.value)} />
        <PersonalInput
          testId="personal-salary-notes"
          label="Nota (opcional)" value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Ej: Sueldo julio, Utilidad Q2..."
        />

        {/* Confirm step */}
        {isValid && (
          <div
            data-testid="personal-salary-confirm"
            onClick={() => setConfirmed(c => !c)}
            role="checkbox"
            aria-checked={confirmed}
            style={{ padding: '0.875rem', background: confirmed ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.025)', border: `1px solid ${confirmed ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '0.875rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${confirmed ? '#34d399' : '#334155'}`, background: confirmed ? 'rgba(52,211,153,0.2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {confirmed && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399' }} />}
            </div>
            <span style={{ fontSize: '0.8rem', color: confirmed ? '#34d399' : '#475569', fontWeight: 600 }}>
              Confirmo retirar {fmtMoney(amt)} del negocio
            </span>
          </div>
        )}

        {error && (
          <div style={{ padding: '0.625rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}

        <PrimaryBtn
          testId="personal-salary-submit"
          onClick={handleConfirm}
          loading={saving}
          disabled={!confirmed || !isValid || accounts.length === 0}
          fullWidth
        >
          <Building2 size={16} /> {saving ? 'Registrando…' : `Registrar retiro${amt > 0 ? ` de ${fmtMoney(amt)}` : ''}`}
        </PrimaryBtn>
      </div>
    </PageContainer>
  )
}
