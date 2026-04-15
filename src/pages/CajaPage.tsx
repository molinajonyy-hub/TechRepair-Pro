import { useEffect, useState, useCallback } from 'react'
import {
  Wallet, TrendingUp, TrendingDown, Plus, X, Loader2,
  AlertCircle, CheckCircle, DollarSign, Lock, Unlock, RefreshCw
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { currencyService } from '../services/currencyService'

type Currency = 'ARS' | 'USD'
type MovementType = 'income' | 'expense'

interface CashRegister {
  id: string
  date: string
  ars_opening: number
  ars_balance: number
  usd_opening: number
  usd_balance: number
  exchange_rate: number
  status: 'open' | 'closed'
  notes?: string
}

interface Movement {
  id: string
  type: MovementType
  currency: Currency
  amount: number
  description?: string
  source: string
  created_at: string
}

const fmtARS = (v: number) =>
  `$${(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtUSD = (v: number) =>
  `USD ${(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export function CajaPage() {
  const { businessId, user } = useAuth()
  const [caja, setCaja] = useState<CashRegister | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exchangeRate, setExchangeRate] = useState(1)

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [modalForm, setModalForm] = useState({
    type: 'income' as MovementType,
    currency: 'ARS' as Currency,
    amount: '',
    description: ''
  })
  const [submitting, setSubmitting] = useState(false)
  const [modalError, setModalError] = useState('')

  const today = new Date().toISOString().split('T')[0]

  const loadExchangeRate = useCallback(async () => {
    const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS').catch(() => 1)
    setExchangeRate(rate || 1)
  }, [])

  const loadCaja = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      // Solo buscar, nunca auto-crear
      const { data: existing } = await supabase
        .from('cash_registers')
        .select('*')
        .eq('business_id', businessId)
        .eq('date', today)
        .maybeSingle()

      if (!existing) {
        setCaja(null)
        setMovements([])
        setLoading(false)
        return
      }

      setCaja(existing as CashRegister)

      // Compute balances from financial_movements for today
      const { data: movs } = await supabase
        .from('financial_movements')
        .select('*')
        .eq('business_id', businessId)
        .eq('date', today)
        .order('created_at', { ascending: false })

      setMovements((movs || []) as Movement[])

      // Recalculate live balances from today's movements
      const arsIn = (movs || []).filter(m => m.currency === 'ARS' && m.type === 'income').reduce((s: number, m: any) => s + m.amount, 0)
      const arsOut = (movs || []).filter(m => m.currency === 'ARS' && m.type === 'expense').reduce((s: number, m: any) => s + m.amount, 0)
      const usdIn = (movs || []).filter(m => m.currency === 'USD' && m.type === 'income').reduce((s: number, m: any) => s + m.amount, 0)
      const usdOut = (movs || []).filter(m => m.currency === 'USD' && m.type === 'expense').reduce((s: number, m: any) => s + m.amount, 0)

      const newARS = (existing as CashRegister).ars_opening + arsIn - arsOut
      const newUSD = (existing as CashRegister).usd_opening + usdIn - usdOut

      // Update balance in DB
      await supabase.from('cash_registers').update({
        ars_balance: newARS,
        usd_balance: newUSD,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id)

      setCaja(prev => prev ? { ...prev, ars_balance: newARS, usd_balance: newUSD } : prev)
    } catch (err: any) {
      setError(err.message || 'Error al cargar caja')
    } finally {
      setLoading(false)
    }
  }, [businessId, today])

  useEffect(() => {
    loadExchangeRate().then(() => loadCaja())
  }, [loadExchangeRate, loadCaja])

  const handleAddMovement = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(modalForm.amount)
    if (!amount || amount <= 0) {
      setModalError('El monto debe ser mayor a 0')
      return
    }
    setSubmitting(true)
    setModalError('')
    try {
      const amountARS = modalForm.currency === 'USD' ? amount * exchangeRate : amount
      await supabase.from('financial_movements').insert({
        business_id: businessId,
        type: modalForm.type,
        currency: modalForm.currency,
        amount,
        exchange_rate: exchangeRate,
        amount_ars: amountARS,
        source: 'manual',
        description: modalForm.description || null,
        date: today,
        created_by: user?.id
      })
      setShowModal(false)
      setModalForm({ type: 'income', currency: 'ARS', amount: '', description: '' })
      await loadCaja()
    } catch (err: any) {
      setModalError(err.message || 'Error al registrar movimiento')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCloseCaja = async () => {
    if (!caja || !confirm('¿Cerrar la caja del día? Esta acción no se puede deshacer.')) return
    await supabase.from('cash_registers').update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      ars_balance: caja.ars_balance,
      usd_balance: caja.usd_balance
    }).eq('id', caja.id)
    await loadCaja()
  }

  const [openForm, setOpenForm] = useState({ arsOpening: '', usdOpening: '' })
  const [openingCaja, setOpeningCaja] = useState(false)

  const handleOpenCaja = async () => {
    if (!businessId) return
    setOpeningCaja(true)
    setError(null)
    try {
      const { data: created, error: createError } = await supabase
        .from('cash_registers')
        .insert({
          business_id: businessId,
          date: today,
          ars_opening: parseFloat(openForm.arsOpening) || 0,
          ars_balance: parseFloat(openForm.arsOpening) || 0,
          usd_opening: parseFloat(openForm.usdOpening) || 0,
          usd_balance: parseFloat(openForm.usdOpening) || 0,
          exchange_rate: exchangeRate,
          status: 'open',
          created_by: user?.id
        })
        .select()
        .single()
      if (createError) throw createError
      setCaja(created as CashRegister)
    } catch (err: any) {
      setError(err.message || 'Error al abrir la caja')
    } finally {
      setOpeningCaja(false)
    }
  }

  const equivalenteARS = (caja?.ars_balance || 0) + (caja?.usd_balance || 0) * exchangeRate

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Wallet size={28} style={{ color: '#10b981' }} />
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>Caja Diaria</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748b', margin: 0 }}>
              {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => loadCaja()}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.5rem 0.875rem',
              backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.5rem',
              color: '#94a3b8', cursor: 'pointer', fontSize: '0.875rem'
            }}
          >
            <RefreshCw size={15} />
            Actualizar
          </button>
          {caja && caja.status === 'open' && (
            <>
              <button
                onClick={() => setShowModal(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.5rem 1rem',
                  backgroundColor: 'rgba(99,102,241,0.15)',
                  border: '1px solid rgba(99,102,241,0.3)',
                  borderRadius: '0.5rem',
                  color: '#818cf8', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500
                }}
              >
                <Plus size={16} />
                Movimiento
              </button>
              <button
                onClick={handleCloseCaja}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.5rem 1rem',
                  backgroundColor: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: '0.5rem',
                  color: '#f87171', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500
                }}
              >
                <Lock size={15} />
                Cerrar Caja
              </button>
            </>
          )}
          {caja?.status === 'closed' && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.5rem 1rem',
              backgroundColor: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '0.5rem',
              color: '#f87171', fontSize: '0.875rem', fontWeight: 600
            }}>
              <Lock size={15} />
              Caja Cerrada
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '0.75rem 1rem', marginBottom: '1rem',
          backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
          borderRadius: '0.5rem', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '0.5rem'
        }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Loader2 size={32} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
        </div>
      ) : !caja ? (
        /* ── Sin caja abierta: form para abrir ── */
        <div style={{ maxWidth: '480px', margin: '4rem auto', textAlign: 'center' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '1rem', backgroundColor: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
            <Unlock size={28} style={{ color: '#10b981' }} />
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc', marginBottom: '0.5rem' }}>No hay caja abierta hoy</h2>
          <p style={{ color: '#64748b', fontSize: '0.9rem', marginBottom: '2rem' }}>
            Ingresá el saldo inicial y abrí la caja para registrar movimientos del día.
          </p>
          <div style={{ backgroundColor: '#111827', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', padding: '1.5rem', textAlign: 'left' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.25rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>
                  Saldo inicial ARS (opcional)
                </label>
                <input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={openForm.arsOpening}
                  onChange={e => setOpenForm(f => ({ ...f, arsOpening: e.target.value }))}
                  style={{
                    width: '100%', padding: '0.625rem 0.875rem',
                    backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.5rem', color: '#34d399', fontSize: '1rem',
                    fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>
                  Saldo inicial USD (opcional)
                </label>
                <input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={openForm.usdOpening}
                  onChange={e => setOpenForm(f => ({ ...f, usdOpening: e.target.value }))}
                  style={{
                    width: '100%', padding: '0.625rem 0.875rem',
                    backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.5rem', color: '#60a5fa', fontSize: '1rem',
                    fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box'
                  }}
                />
              </div>
            </div>
            <button
              onClick={handleOpenCaja}
              disabled={openingCaja}
              style={{
                width: '100%', padding: '0.75rem',
                backgroundColor: openingCaja ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.2)',
                border: '1px solid rgba(16,185,129,0.4)',
                borderRadius: '0.5rem', color: '#34d399',
                fontWeight: 700, fontSize: '1rem', cursor: openingCaja ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem'
              }}
            >
              {openingCaja ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : <Unlock size={18} />}
              {openingCaja ? 'Abriendo...' : 'Abrir Caja'}
            </button>
          </div>
        </div>
      ) : caja && (
        <>
          {/* Balance Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {/* ARS */}
            <div style={{
              padding: '1.25rem',
              backgroundColor: '#111827',
              border: '1px solid rgba(52,211,153,0.2)',
              borderRadius: '0.75rem',
              borderLeft: '4px solid #34d399'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: 'rgba(52,211,153,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#34d399' }}>ARS</span>
                </div>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Saldo en Pesos</span>
              </div>
              <p style={{ fontSize: '1.75rem', fontWeight: 700, color: '#34d399', fontFamily: 'monospace', margin: 0, letterSpacing: '-0.02em' }}>
                {fmtARS(caja.ars_balance)}
              </p>
              <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0' }}>
                Apertura: {fmtARS(caja.ars_opening)}
              </p>
            </div>

            {/* USD */}
            <div style={{
              padding: '1.25rem',
              backgroundColor: '#111827',
              border: '1px solid rgba(96,165,250,0.2)',
              borderRadius: '0.75rem',
              borderLeft: '4px solid #60a5fa'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: 'rgba(96,165,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DollarSign size={14} style={{ color: '#60a5fa' }} />
                </div>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Saldo en Dólares</span>
              </div>
              <p style={{ fontSize: '1.75rem', fontWeight: 700, color: '#60a5fa', fontFamily: 'monospace', margin: 0, letterSpacing: '-0.02em' }}>
                {fmtUSD(caja.usd_balance)}
              </p>
              <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0' }}>
                Apertura: {fmtUSD(caja.usd_opening)}
              </p>
            </div>

            {/* Equivalente */}
            <div style={{
              padding: '1.25rem',
              backgroundColor: '#111827',
              border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: '0.75rem',
              borderLeft: '4px solid #6366f1'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem', backgroundColor: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Wallet size={14} style={{ color: '#818cf8' }} />
                </div>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Total Equivalente</span>
              </div>
              <p style={{ fontSize: '1.75rem', fontWeight: 700, color: '#818cf8', fontFamily: 'monospace', margin: 0, letterSpacing: '-0.02em' }}>
                {fmtARS(equivalenteARS)}
              </p>
              <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0' }}>
                TC: ${exchangeRate.toLocaleString('es-AR')}
              </p>
            </div>
          </div>

          {/* Movements table */}
          <div style={{
            backgroundColor: '#111827',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: '0.75rem',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#e2e8f0', margin: 0 }}>
                Movimientos de Hoy
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#475569' }}>
                {movements.length} registros
              </span>
            </div>

            {movements.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#475569' }}>
                <Wallet size={32} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
                <p style={{ margin: 0 }}>Sin movimientos hoy</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}>
                      {['Tipo', 'Descripción', 'Moneda', 'Monto', 'Fuente', 'Hora'].map(h => (
                        <th key={h} style={{
                          padding: '0.75rem 1rem',
                          textAlign: 'left',
                          color: '#475569',
                          fontWeight: 500,
                          fontSize: '0.75rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          borderBottom: '1px solid rgba(255,255,255,0.05)'
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map(mov => (
                      <tr key={mov.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '0.25rem',
                            backgroundColor: mov.type === 'income' ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                            color: mov.type === 'income' ? '#34d399' : '#f87171',
                            fontSize: '0.75rem', fontWeight: 600
                          }}>
                            {mov.type === 'income' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                            {mov.type === 'income' ? 'Ingreso' : 'Egreso'}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#cbd5e1' }}>
                          {mov.description || '—'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <span style={{
                            padding: '0.15rem 0.4rem',
                            borderRadius: '0.25rem',
                            backgroundColor: mov.currency === 'USD' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.1)',
                            color: mov.currency === 'USD' ? '#60a5fa' : '#34d399',
                            fontSize: '0.7rem', fontWeight: 700
                          }}>
                            {mov.currency}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', color: mov.type === 'income' ? '#34d399' : '#f87171', fontWeight: 600 }}>
                          {mov.type === 'income' ? '+' : '-'}
                          {mov.currency === 'USD' ? fmtUSD(mov.amount) : fmtARS(mov.amount)}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#475569', fontSize: '0.75rem' }}>
                          {({'manual':'Manual','payment':'Pago','expense':'Gasto'} as Record<string,string>)[mov.source] || mov.source}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#475569', fontSize: '0.75rem' }}>
                          {fmtDate(mov.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Modal movimiento manual */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0,
          backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 50, padding: '1rem'
        }}>
          <div style={{
            backgroundColor: '#0f172a',
            border: '1px solid rgba(51,65,85,0.5)',
            borderRadius: '0.75rem',
            width: '100%', maxWidth: '440px',
            padding: '1.5rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                Registrar Movimiento
              </h3>
              <button onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>

            {modalError && (
              <div style={{
                padding: '0.625rem 0.875rem', marginBottom: '1rem',
                backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
                borderRadius: '0.375rem', color: '#f87171', fontSize: '0.875rem',
                display: 'flex', alignItems: 'center', gap: '0.5rem'
              }}>
                <AlertCircle size={14} /> {modalError}
              </div>
            )}

            <form onSubmit={handleAddMovement} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Tipo */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Tipo</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {([['income', 'Ingreso', '#34d399'], ['expense', 'Egreso', '#f87171']] as const).map(([val, label, color]) => (
                    <button
                      key={val} type="button"
                      onClick={() => setModalForm(f => ({ ...f, type: val }))}
                      style={{
                        flex: 1, padding: '0.5rem',
                        borderRadius: '0.375rem',
                        border: `2px solid ${modalForm.type === val ? color : 'rgba(255,255,255,0.08)'}`,
                        backgroundColor: modalForm.type === val ? `${color}22` : 'transparent',
                        color: modalForm.type === val ? color : '#64748b',
                        fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer'
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Moneda */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Moneda</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(['ARS', 'USD'] as Currency[]).map(c => (
                    <button
                      key={c} type="button"
                      onClick={() => setModalForm(f => ({ ...f, currency: c }))}
                      style={{
                        flex: 1, padding: '0.5rem',
                        borderRadius: '0.375rem',
                        border: `2px solid ${modalForm.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : 'rgba(255,255,255,0.08)'}`,
                        backgroundColor: modalForm.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.1)') : 'transparent',
                        color: modalForm.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : '#64748b',
                        fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer'
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Monto */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>
                  Monto ({modalForm.currency})
                </label>
                <input
                  type="number" min="0.01" step="0.01" required
                  value={modalForm.amount}
                  onChange={e => setModalForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  style={{
                    width: '100%', padding: '0.625rem 0.875rem',
                    backgroundColor: 'rgba(15,23,42,0.6)',
                    border: '1px solid rgba(51,65,85,0.5)',
                    borderRadius: '0.375rem', color: '#f8fafc',
                    fontSize: '1rem', fontFamily: 'monospace', outline: 'none'
                  }}
                />
              </div>

              {/* Descripción */}
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Descripción (opcional)</label>
                <input
                  type="text"
                  value={modalForm.description}
                  onChange={e => setModalForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Ej: Pago de alquiler, cobro cliente..."
                  style={{
                    width: '100%', padding: '0.625rem 0.875rem',
                    backgroundColor: 'rgba(15,23,42,0.6)',
                    border: '1px solid rgba(51,65,85,0.5)',
                    borderRadius: '0.375rem', color: '#f8fafc',
                    fontSize: '0.875rem', outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  style={{
                    flex: 1, padding: '0.625rem',
                    backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.375rem', color: '#94a3b8', cursor: 'pointer', fontSize: '0.875rem'
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit" disabled={submitting}
                  style={{
                    flex: 2, padding: '0.625rem',
                    backgroundColor: submitting ? 'rgba(99,102,241,0.5)' : '#6366f1',
                    border: 'none',
                    borderRadius: '0.375rem', color: '#fff',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem', fontWeight: 500,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem'
                  }}
                >
                  {submitting ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</> : <><CheckCircle size={15} /> Guardar</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
