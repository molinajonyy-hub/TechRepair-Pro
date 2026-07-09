import { useState, useEffect, useRef, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { X, Zap, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import {
  personalService,
  type PersonalAccount,
  type PersonalCategory,
  getAccountCurrencies,
} from '../services/personalService'
import { showToast } from './ui'
import { logger } from '../../lib/logger'
import { useKeyboardAwareBottomOffset } from '../../hooks/useKeyboardAwareBottomOffset'

// ─── Context ──────────────────────────────────────────────────────────────────

interface QuickExpenseCtx { openPopup: () => void }
const QuickExpenseContext = createContext<QuickExpenseCtx>({ openPopup: () => {} })
export const useQuickExpense = () => useContext(QuickExpenseContext)
export { QuickExpenseContext }

// ─── localStorage keys ────────────────────────────────────────────────────────

const LAST_ACCOUNT_KEY  = 'miGuitaQuickExpenseLastAccount'
const LAST_CATEGORY_KEY = 'miGuitaQuickExpenseLastCategory'

// ─── Component ────────────────────────────────────────────────────────────────

export interface QuickExpensePopupProps {
  open: boolean
  onClose: () => void
}

export function QuickExpensePopup({ open, onClose }: QuickExpensePopupProps) {
  const { user }   = useAuth()
  const navigate   = useNavigate()
  const amountRef  = useRef<HTMLInputElement>(null)
  const keyboardH  = useKeyboardAwareBottomOffset()

  const [accounts,    setAccounts]    = useState<PersonalAccount[]>([])
  const [categories,  setCategories]  = useState<PersonalCategory[]>([])
  const [loadingData, setLoadingData] = useState(false)
  const [amount,      setAmount]      = useState('')
  const [description, setDescription] = useState('')
  const [accountId,   setAccountId]   = useState('')
  const [categoryId,  setCategoryId]  = useState('')
  const [currency,    setCurrency]    = useState('ARS')
  const [saving,      setSaving]      = useState(false)
  const [saved,       setSaved]       = useState(false)
  const [error,       setError]       = useState('')

  // Lazy-load cuentas + categorías al abrir
  useEffect(() => {
    if (!open || !user) return
    setLoadingData(true)
    Promise.all([
      personalService.getAccounts(user.id),
      personalService.getCategories(user.id),
    ])
      .then(([accts, cats]) => {
        setAccounts(accts)
        setCategories(cats)

        const lastAccId = localStorage.getItem(LAST_ACCOUNT_KEY)
        const validAcc  = accts.find(a => a.id === lastAccId) ?? accts[0]
        if (validAcc) {
          setAccountId(validAcc.id)
          setCurrency(getAccountCurrencies(validAcc)[0] ?? 'ARS')
        }

        const lastCatId = localStorage.getItem(LAST_CATEGORY_KEY)
        const expCats   = cats.filter(c => c.type === 'expense' && c.is_active)
        const validCat  = expCats.find(c => c.id === lastCatId) ?? expCats[0] ?? null
        if (validCat) setCategoryId(validCat.id)
      })
      .catch(() => {})
      .finally(() => setLoadingData(false))
  }, [open, user])

  // Autofocus monto después de la animación
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => amountRef.current?.focus(), 240)
    return () => clearTimeout(t)
  }, [open])

  // Reset al cerrar
  useEffect(() => {
    if (!open) {
      setAmount('')
      setDescription('')
      setError('')
      setSaving(false)
      setSaved(false)
    }
  }, [open])

  // Escape key
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open, onClose])

  const handleAccountChange = (id: string) => {
    setAccountId(id)
    const acc = accounts.find(a => a.id === id)
    if (acc) setCurrency(getAccountCurrencies(acc)[0] ?? 'ARS')
  }

  const handleSave = async () => {
    if (!user || saving || saved) return
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (!accountId)        { setError('Seleccioná una cuenta'); return }
    setError('')
    setSaving(true)
    try {
      await personalService.createTransaction(user.id, {
        account_id:                 accountId,
        category_id:                categoryId || null,
        type:                       'expense',
        amount:                     amt,
        currency,
        date:                       new Date().toISOString().split('T')[0],
        description:                description.trim() || 'Gasto rápido',
        notes:                      null,
        payment_method:             null,
        linked_owner_withdrawal_id: null,
      })
      localStorage.setItem(LAST_ACCOUNT_KEY, accountId)
      if (categoryId) localStorage.setItem(LAST_CATEGORY_KEY, categoryId)
      setSaved(true)
      showToast({ message: 'Gasto registrado', type: 'success' })
      setTimeout(() => onClose(), 600)
    } catch (e: unknown) {
      logger.error('PERSONAL', 'quickExpense: save failed', e)
      setError((e instanceof Error ? e.message : null) || 'Error al guardar')
      setSaving(false)
    }
  }

  if (!open || typeof document === 'undefined') return null

  const expCats    = categories.filter(c => c.type === 'expense' && c.is_active)
  const noAccounts = !loadingData && accounts.length === 0
  const parsedAmt  = parseFloat(amount.replace(',', '.'))
  const canSave    = !!amount && parsedAmt > 0 && !!accountId && !saving && !saved

  // Posición: sobre el teclado si está abierto, si no sobre el bottom nav + safe-area
  const bottomVal = keyboardH > 0
    ? `${keyboardH + 8}px`
    : 'calc(env(safe-area-inset-bottom, 0px) + 84px)'

  return createPortal(
    <>
      {/* Overlay suave — clic para cerrar */}
      <div
        data-testid="quick-expense-overlay"
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 4999,
          background: 'rgba(0, 0, 0, 0.28)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          animation: 'qeOverlayIn 0.18s ease',
        }}
      />

      {/* Panel flotante inferior — liquid glass.
          data-theme="dark": portal fuera de la isla dark de Mi Guita. */}
      <div
        data-testid="quick-expense-popup"
        data-theme="dark"
        style={{
          position: 'fixed',
          left: '12px',
          right: '12px',
          bottom: bottomVal,
          zIndex: 5000,
          borderRadius: '28px',
          background: 'linear-gradient(135deg, rgba(15,23,42,0.88) 0%, rgba(6,50,40,0.60) 100%)',
          backdropFilter: 'blur(28px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.15)',
          animation: 'qeSlideUp 0.22s cubic-bezier(0.34,1.56,0.64,1)',
          overflow: 'hidden',
          transition: 'bottom 0.2s ease',
          maxWidth: '456px',
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {/* Línea de brillo superior (efecto liquid glass) */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 1,
          background: 'linear-gradient(90deg, transparent 0%, rgba(52,211,153,0.45) 50%, transparent 100%)',
          pointerEvents: 'none',
        }} />

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.125rem 0.75rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{
              width: 30, height: 30, borderRadius: '0.625rem', flexShrink: 0,
              background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 12px rgba(248,113,113,0.18)',
            }}>
              <Zap size={14} color="#f87171" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '0.9375rem', color: '#f0f4ff', letterSpacing: '-0.01em', lineHeight: 1.2 }}>
                Gasto rápido
              </div>
              <div style={{ fontSize: '0.6rem', color: '#475569', marginTop: '0.05rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                Hoy · gasto
              </div>
            </div>
          </div>
          <button
            data-testid="quick-expense-close"
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#94a3b8',
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Divisor */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '0 1.125rem' }} />

        {/* ── Cuerpo del formulario ── */}
        <div style={{ padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>

          {noAccounts ? (
            <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
              <div style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.5, marginBottom: '0.875rem' }}>
                Primero necesitás crear una cuenta para registrar gastos.
              </div>
              <button
                onClick={() => { onClose(); navigate('/personal/cuentas') }}
                style={{
                  background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)',
                  borderRadius: '0.875rem', padding: '0.625rem 1.25rem',
                  color: '#34d399', fontWeight: 700, fontSize: '0.8125rem',
                  cursor: 'pointer', minHeight: 44,
                }}
              >
                Crear cuenta
              </button>
            </div>
          ) : saved ? (
            /* Estado de confirmación breve antes de cerrar */
            <div style={{ textAlign: 'center', padding: '0.75rem 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.375rem', color: '#34d399',
              }}>
                ✓
              </div>
              <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#34d399' }}>Gasto registrado</div>
            </div>
          ) : (
            <>
              {/* Monto */}
              <div style={{ position: 'relative' }}>
                <span style={{
                  position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)',
                  color: '#f87171', fontWeight: 900, fontSize: '1.5rem',
                  pointerEvents: 'none', fontFamily: 'monospace', opacity: 0.65,
                }}>
                  $
                </span>
                <input
                  ref={amountRef}
                  data-testid="quick-expense-amount"
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]*[.,]?[0-9]*"
                  value={amount}
                  onChange={e => { setAmount(e.target.value); setError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
                  placeholder="0"
                  autoComplete="off"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '0.875rem 1rem 0.875rem 2.5rem',
                    background: 'rgba(248,113,113,0.07)',
                    border: `1.5px solid ${error && !amount ? 'rgba(248,113,113,0.55)' : 'rgba(248,113,113,0.22)'}`,
                    borderRadius: '1rem',
                    color: '#f87171',
                    fontSize: '1.625rem',
                    fontWeight: 900, fontFamily: 'monospace',
                    outline: 'none', textAlign: 'right',
                    letterSpacing: '-0.02em',
                  }}
                />
              </div>

              {/* Descripción */}
              <input
                data-testid="quick-expense-description"
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="café, nafta, comida… (opcional)"
                autoComplete="off"
                autoCapitalize="sentences"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.625rem 0.875rem',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: '0.875rem',
                  color: '#94a3b8',
                  fontSize: '1rem',
                  outline: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              />

              {/* Categoría + Cuenta */}
              {loadingData ? (
                <div style={{ height: 52, background: 'rgba(255,255,255,0.04)', borderRadius: '0.875rem', animation: 'qePulse 1.2s ease infinite' }} />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <div>
                    <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                      Categoría
                    </div>
                    <div style={{ position: 'relative' }}>
                      <select
                        data-testid="quick-expense-category"
                        value={categoryId}
                        onChange={e => setCategoryId(e.target.value)}
                        style={{
                          width: '100%', padding: '0.5rem 1.75rem 0.5rem 0.625rem',
                          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '0.8125rem',
                          outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
                          minHeight: 38,
                        }}
                      >
                        <option value="">Sin categoría</option>
                        {expCats.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
                      </select>
                      <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none', fontSize: '0.6rem' }}>▾</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>
                      Cuenta
                    </div>
                    <div style={{ position: 'relative' }}>
                      <select
                        data-testid="quick-expense-account"
                        value={accountId}
                        onChange={e => handleAccountChange(e.target.value)}
                        style={{
                          width: '100%', padding: '0.5rem 1.75rem 0.5rem 0.625rem',
                          background: 'rgba(255,255,255,0.05)',
                          border: `1px solid ${!accountId && error ? 'rgba(248,113,113,0.45)' : 'rgba(255,255,255,0.1)'}`,
                          borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '0.8125rem',
                          outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
                          minHeight: 38,
                        }}
                      >
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none', fontSize: '0.6rem' }}>▾</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Error inline */}
              {error && (
                <div style={{
                  padding: '0.4rem 0.75rem',
                  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                  borderRadius: '0.625rem', color: '#f87171', fontSize: '0.78rem',
                }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        {!noAccounts && !saved && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0 1.125rem 1.125rem' }}>
            <button
              data-testid="quick-expense-full-form"
              onClick={() => { onClose(); navigate('/personal/movimientos') }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#334155', fontSize: '0.78rem', fontWeight: 600,
                padding: '0.5rem 0', flexShrink: 0, minHeight: 44, whiteSpace: 'nowrap',
              }}
            >
              Completo <ChevronRight size={12} />
            </button>
            <button
              data-testid="quick-expense-save"
              onClick={() => void handleSave()}
              disabled={!canSave}
              style={{
                flex: 1, padding: '0.875rem', borderRadius: '1rem', border: 'none',
                background: canSave ? '#34d399' : 'rgba(52,211,153,0.1)',
                color: canSave ? '#071018' : 'rgba(52,211,153,0.3)',
                fontWeight: 800, fontSize: '0.9375rem',
                cursor: canSave ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s', minHeight: 48,
                letterSpacing: '-0.01em',
                boxShadow: canSave ? '0 4px 16px rgba(52,211,153,0.22)' : 'none',
              }}
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>

      {/* Animaciones */}
      <style>{`
        @keyframes qeOverlayIn {
          from { opacity: 0 }
          to   { opacity: 1 }
        }
        @keyframes qeSlideUp {
          from { opacity: 0; transform: translateY(40px) scale(0.96) }
          to   { opacity: 1; transform: translateY(0)    scale(1)    }
        }
        @keyframes qePulse {
          0%, 100% { opacity: 0.35 }
          50%       { opacity: 0.75 }
        }
        @supports not ((backdrop-filter: blur(10px)) or (-webkit-backdrop-filter: blur(10px))) {
          [data-testid="quick-expense-popup"] {
            background: rgba(11, 20, 35, 0.97) !important;
          }
        }
      `}</style>
    </>,
    document.body
  )
}
