/**
 * QuickExpensePopup — ventana de gasto rápido para Mi Guita.
 *
 * Se activa desde deep link (/personal?quickExpense=1) o manualmente.
 * Aparece desde la parte superior de la pantalla con animación de slide-down.
 * Diseñada para registrar un gasto en segundos desde iPhone con Toque posterior.
 */
import { useState, useEffect, useRef, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronRight, Zap } from 'lucide-react'
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

  const [accounts,    setAccounts]    = useState<PersonalAccount[]>([])
  const [categories,  setCategories]  = useState<PersonalCategory[]>([])
  const [loadingData, setLoadingData] = useState(false)
  const [amount,      setAmount]      = useState('')
  const [description, setDescription] = useState('')
  const [accountId,   setAccountId]   = useState('')
  const [categoryId,  setCategoryId]  = useState('')
  const [currency,    setCurrency]    = useState('ARS')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  // Load accounts + categories when popup opens
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
      .catch(() => {/* silent — user sees empty selects */})
      .finally(() => setLoadingData(false))
  }, [open, user])

  // Autofocus amount after animation completes
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => amountRef.current?.focus(), 180)
    return () => clearTimeout(t)
  }, [open])

  // Reset form when closed
  useEffect(() => {
    if (!open) {
      setAmount('')
      setDescription('')
      setError('')
      setSaving(false)
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
    if (!user || saving) return
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setError('El monto debe ser mayor a $0'); return }
    if (!accountId)        { setError('Seleccioná una cuenta'); return }
    setError('')
    setSaving(true)
    try {
      await personalService.createTransaction(user.id, {
        account_id:                   accountId,
        category_id:                  categoryId || null,
        type:                         'expense',
        amount:                       amt,
        currency,
        date:                         new Date().toISOString().split('T')[0],
        description:                  description.trim() || 'Gasto rápido',
        notes:                        null,
        payment_method:               null,
        linked_owner_withdrawal_id:   null,
      })
      localStorage.setItem(LAST_ACCOUNT_KEY, accountId)
      if (categoryId) localStorage.setItem(LAST_CATEGORY_KEY, categoryId)
      showToast({ message: 'Gasto registrado', type: 'success' })
      onClose()
    } catch (e: any) {
      logger.error('PERSONAL', 'quickExpense: save failed', e)
      setError(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  const handleFullForm = () => {
    onClose()
    navigate('/personal/movimientos')
  }

  if (!open || typeof document === 'undefined') return null

  const expCats    = categories.filter(c => c.type === 'expense' && c.is_active)
  const noAccounts = !loadingData && accounts.length === 0
  const canSave    = !!amount && !!accountId && !saving

  return createPortal(
    <>
      {/* Dim overlay — click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 400,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          animation: 'qeFadeIn 0.15s ease',
        }}
      />

      {/* Popup card — slides from top */}
      <div
        data-testid="quick-expense-popup"
        style={{
          position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)',
          width: '100%', maxWidth: 480, zIndex: 401,
          background: '#0b1626',
          borderBottom: '1px solid rgba(52,211,153,0.25)',
          borderLeft:   '1px solid rgba(255,255,255,0.07)',
          borderRight:  '1px solid rgba(255,255,255,0.07)',
          borderRadius: '0 0 1.5rem 1.5rem',
          boxShadow: '0 12px 48px rgba(0,0,0,0.65), 0 0 0 0.5px rgba(52,211,153,0.1)',
          paddingTop: 'max(1.125rem, env(safe-area-inset-top, 1.125rem))',
          animation: 'qeSlideDown 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.125rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: 28, height: 28, borderRadius: '0.5rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Zap size={14} color="#f87171" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '0.9375rem', color: '#f0f4ff', letterSpacing: '-0.01em' }}>Gasto rápido</div>
              <div style={{ fontSize: '0.65rem', color: '#334155', marginTop: '0.05rem' }}>Fecha de hoy · sin notas adicionales</div>
            </div>
          </div>
          <button
            data-testid="quick-expense-close"
            onClick={onClose}
            aria-label="Cerrar gasto rápido"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#94a3b8', flexShrink: 0 }}
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Form ── */}
        <div style={{ padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>

          {noAccounts ? (
            /* No hay cuentas */
            <div style={{ textAlign: 'center', padding: '0.75rem 0 0.25rem' }}>
              <div style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.5, marginBottom: '0.875rem' }}>
                Primero necesitás crear una cuenta para registrar gastos.
              </div>
              <button
                onClick={() => { onClose(); navigate('/personal/cuentas') }}
                style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '0.75rem', padding: '0.625rem 1.25rem', color: '#34d399', fontWeight: 700, fontSize: '0.8125rem', cursor: 'pointer' }}
              >
                Crear cuenta
              </button>
            </div>
          ) : (
            <>
              {/* Monto */}
              <div>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>Monto *</div>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: '#f87171', fontWeight: 900, fontSize: '1.375rem', pointerEvents: 'none', fontFamily: 'monospace' }}>
                    $
                  </span>
                  <input
                    ref={amountRef}
                    data-testid="quick-expense-amount"
                    type="text"
                    inputMode="decimal"
                    pattern="[0-9]*[.,]?[0-9]*"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
                    placeholder="0"
                    autoComplete="off"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '0.75rem 0.875rem 0.75rem 2.375rem',
                      background: 'rgba(248,113,113,0.06)',
                      border: '1.5px solid rgba(248,113,113,0.25)',
                      borderRadius: '0.875rem',
                      color: '#f87171',
                      // 16px min para evitar zoom en iOS
                      fontSize: '1.625rem',
                      fontWeight: 900, fontFamily: 'monospace',
                      outline: 'none', textAlign: 'right',
                    }}
                  />
                </div>
              </div>

              {/* Descripción */}
              <input
                data-testid="quick-expense-description"
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Descripción: café, nafta, comida... (opcional)"
                autoComplete="off"
                autoCapitalize="sentences"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.625rem 0.875rem',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.75rem',
                  color: '#f0f4ff',
                  fontSize: '1rem',
                  outline: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              />

              {/* Categoría + Cuenta */}
              {loadingData ? (
                <div style={{ height: 56, background: 'rgba(255,255,255,0.03)', borderRadius: '0.75rem', animation: 'qePulse 1.2s ease infinite' }} />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {/* Categoría */}
                  <div>
                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>Categoría</div>
                    <div style={{ position: 'relative' }}>
                      <select
                        data-testid="quick-expense-category"
                        value={categoryId}
                        onChange={e => setCategoryId(e.target.value)}
                        style={{ width: '100%', padding: '0.5rem 1.75rem 0.5rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '0.8125rem', outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none' }}
                      >
                        <option value="">Sin categoría</option>
                        {expCats.map(c => (
                          <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                        ))}
                      </select>
                      <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none', fontSize: '0.65rem' }}>▾</span>
                    </div>
                  </div>
                  {/* Cuenta */}
                  <div>
                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>Cuenta</div>
                    <div style={{ position: 'relative' }}>
                      <select
                        data-testid="quick-expense-account"
                        value={accountId}
                        onChange={e => handleAccountChange(e.target.value)}
                        style={{ width: '100%', padding: '0.5rem 1.75rem 0.5rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '0.8125rem', outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none' }}
                      >
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none', fontSize: '0.65rem' }}>▾</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Error inline */}
              {error && (
                <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.625rem', color: '#f87171', fontSize: '0.8rem' }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer actions ── */}
        {!noAccounts && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0 1.125rem 1.25rem' }}>
            <button
              data-testid="quick-expense-full-form"
              onClick={handleFullForm}
              style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '0.78rem', fontWeight: 600, padding: '0.5rem 0', flexShrink: 0, minHeight: 44 }}
            >
              Ver formulario completo <ChevronRight size={12} />
            </button>
            <button
              data-testid="quick-expense-save"
              onClick={() => void handleSave()}
              disabled={!canSave}
              style={{
                flex: 1, padding: '0.875rem', borderRadius: '1rem', border: 'none',
                background: canSave ? '#34d399' : 'rgba(52,211,153,0.12)',
                color: canSave ? '#071018' : 'rgba(52,211,153,0.4)',
                fontWeight: 800, fontSize: '0.9375rem',
                cursor: canSave ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s', minHeight: 48,
                letterSpacing: '-0.01em',
              }}
            >
              {saving ? 'Guardando…' : 'Guardar gasto'}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes qeFadeIn  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes qeSlideDown {
          from { transform: translateX(-50%) translateY(-100%) }
          to   { transform: translateX(-50%) translateY(0) }
        }
        @keyframes qePulse {
          0%, 100% { opacity: 0.5 }
          50%       { opacity: 1 }
        }
      `}</style>
    </>,
    document.body
  )
}
