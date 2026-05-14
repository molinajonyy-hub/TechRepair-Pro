type ToastVariant = 'success' | 'error' | 'warning' | 'info'

const TOAST_COLORS: Record<ToastVariant, { bg: string; border: string; icon: string }> = {
  success: { bg: '#052e16', border: '#22c55e', icon: '✅' },
  error:   { bg: '#1c1917', border: '#ef4444', icon: '❌' },
  warning: { bg: '#1c1917', border: '#f59e0b', icon: '⚠️' },
  info:    { bg: '#0f1e35', border: '#6366f1', icon: '💬' },
}

let styleInjected = false

export function showToast(
  message: string,
  variant: ToastVariant = 'info',
  duration = 4000,
) {
  if (!styleInjected) {
    const s = document.createElement('style')
    s.textContent = `@keyframes trp-slideUp { from { opacity:0; transform:translateX(-50%) translateY(12px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`
    document.head.appendChild(s)
    styleInjected = true
  }

  const c = TOAST_COLORS[variant]
  const el = document.createElement('div')
  el.style.cssText = `
    position:fixed; bottom:1.5rem; left:50%; transform:translateX(-50%);
    z-index:99999; max-width:480px; width:calc(100vw - 2rem);
    background:${c.bg}; border:1px solid ${c.border};
    border-radius:0.875rem; padding:0.875rem 1.125rem;
    display:flex; align-items:center; gap:0.75rem;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    animation:trp-slideUp 0.25s cubic-bezier(0.22,1,0.36,1);
  `
  el.innerHTML = `
    <span style="font-size:1.1rem;flex-shrink:0">${c.icon}</span>
    <span style="flex:1;color:#e2e8f0;font-size:0.85rem;line-height:1.45">${message}</span>
    <button style="flex-shrink:0;background:none;border:none;cursor:pointer;color:#64748b;font-size:1.1rem;line-height:1">✕</button>
  `
  document.body.appendChild(el)

  const close = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200) }
  el.querySelector('button')?.addEventListener('click', close)
  setTimeout(close, duration)
}
