/**
 * useFeatureErrorHandler — Middleware global para errores de suscripción.
 *
 * Centraliza toast, tracking y UX de todos los FeatureError del sistema.
 * Usar en cualquier componente que llame a requireFeature() o servicios premium.
 *
 * @example
 *   const handleFeatureError = useFeatureErrorHandler()
 *   try {
 *     await requireFeature(businessId, FEATURES.ARCA)
 *   } catch (e) {
 *     handleFeatureError(e)   // toast automático + log
 *   }
 */

import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isFeatureError, type FeatureError } from '../utils/requireFeature'

export function useFeatureErrorHandler() {
  const navigate = useNavigate()

  return useCallback((error: unknown) => {
    if (!isFeatureError(error)) return false  // no era un FeatureError

    const e = error as FeatureError

    switch (e.code) {
      case 'UPGRADE_REQUIRED':
        showToast(e.message, 'upgrade', () => navigate('/subscription/plans'))
        break
      case 'SUBSCRIPTION_INACTIVE':
        showToast(e.message, 'inactive', () => navigate('/subscription'))
        break
      case 'SUBSCRIPTION_VALIDATION_FAILED':
        showToast(e.message, 'error')
        break
      case 'FEATURE_NOT_AVAILABLE':
        showToast(e.message, 'error')
        break
    }

    return true  // fue manejado
  }, [navigate])
}

// ─── Toast interno ────────────────────────────────────────────────────────────

type ToastVariant = 'upgrade' | 'inactive' | 'error'

function showToast(message: string, variant: ToastVariant, action?: () => void) {
  const colors = {
    upgrade:  { bg: '#1e1b4b', border: '#4f46e5', icon: '🔒', actionLabel: 'Ver planes' },
    inactive: { bg: '#1c1917', border: '#f59e0b', icon: '⚠️', actionLabel: 'Renovar' },
    error:    { bg: '#1c1917', border: '#ef4444', icon: '⚠️', actionLabel: '' },
  }
  const c = colors[variant]

  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
    z-index: 99999; max-width: 480px; width: calc(100vw - 2rem);
    background: ${c.bg}; border: 1px solid ${c.border};
    border-radius: 0.875rem; padding: 0.875rem 1.125rem;
    display: flex; align-items: center; gap: 0.75rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    animation: slideUp 0.25s cubic-bezier(0.22,1,0.36,1);
  `

  const style = document.createElement('style')
  style.textContent = `@keyframes slideUp { from { opacity:0; transform: translateX(-50%) translateY(12px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`
  document.head.appendChild(style)

  el.innerHTML = `
    <span style="font-size:1.1rem;flex-shrink:0">${c.icon}</span>
    <span style="flex:1;color:#e2e8f0;font-size:0.85rem;line-height:1.45">${message}</span>
    ${action && c.actionLabel ? `<button id="feat-toast-action" style="flex-shrink:0;padding:0.35rem 0.875rem;background:${c.border};border:none;border-radius:0.5rem;color:#fff;font-size:0.78rem;font-weight:700;cursor:pointer">${c.actionLabel}</button>` : ''}
    <button id="feat-toast-close" style="flex-shrink:0;background:none;border:none;cursor:pointer;color:#64748b;font-size:1.1rem;line-height:1">✕</button>
  `

  document.body.appendChild(el)

  const close = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200) }
  el.querySelector('#feat-toast-close')?.addEventListener('click', close)
  el.querySelector('#feat-toast-action')?.addEventListener('click', () => { close(); action?.() })

  setTimeout(close, 5000)
}
