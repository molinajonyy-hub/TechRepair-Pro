import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Detecta el parámetro de URL que activa el Gasto rápido.
 *
 * Acepta:
 *   /personal?quickExpense=1
 *   /personal?action=quick-expense
 *   /personal#quick-expense
 *
 * Limpia el parámetro de la URL con history.replaceState sin re-render.
 */
export function useQuickExpenseShortcut() {
  const [open, setOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const isShortcut =
      params.get('quickExpense') === '1' ||
      params.get('action') === 'quick-expense' ||
      location.hash === '#quick-expense'

    if (isShortcut) {
      window.history.replaceState(null, '', location.pathname)
      setOpen(true)
    }
  }, [location.search, location.hash, location.pathname])

  return {
    open,
    openPopup:  () => setOpen(true),
    closePopup: () => setOpen(false),
  }
}
