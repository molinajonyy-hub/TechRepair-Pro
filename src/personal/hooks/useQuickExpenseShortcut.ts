import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

const PENDING_KEY = 'miGuitaPendingQuickExpense'
const DEBOUNCE_MS = 800

/**
 * Detecta intención de abrir el Gasto rápido desde múltiples fuentes:
 *   - URL params: ?quickExpense=1 | ?action=quick-expense | #quick-expense
 *   - sessionStorage pending intent (cubre PWA restore + redirect desde /mi-guita)
 *   - Eventos del navegador: pageshow (bfcache), visibilitychange, focus
 *
 * Anti-double-open: ignora aperturas con menos de 800ms de diferencia.
 */
export function useQuickExpenseShortcut() {
  const [open, setOpen] = useState(false)
  const location    = useLocation()
  const lastOpenMs  = useRef(0)

  const tryOpen = () => {
    const now = Date.now()
    if (now - lastOpenMs.current < DEBOUNCE_MS) return
    lastOpenMs.current = now
    setOpen(true)
  }

  // Detectar URL params / hash en cada cambio de location
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const hit =
      params.get('quickExpense') === '1' ||
      params.get('action') === 'quick-expense' ||
      location.hash === '#quick-expense'
    if (hit) {
      window.history.replaceState(null, '', location.pathname)
      tryOpen()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, location.hash, location.pathname])

  // Pending intent + eventos de ciclo de vida del navegador
  useEffect(() => {
    const checkPending = () => {
      if (sessionStorage.getItem(PENDING_KEY) === '1') {
        sessionStorage.removeItem(PENDING_KEY)
        tryOpen()
      }
    }

    checkPending() // en mount: cubre PWA que vuelve del background

    const onPageShow  = (e: PageTransitionEvent) => { if (e.persisted) checkPending() }
    const onVisible   = () => { if (document.visibilityState === 'visible') checkPending() }
    const onFocus     = () => checkPending()

    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)

    return () => {
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    open,
    openPopup:  () => tryOpen(),
    closePopup: () => setOpen(false),
  }
}
