import { useCallback, useEffect, useRef, useState } from 'react'

/** Cuánto queda a la vista la confirmación de un guardado. */
export const SAVED_NOTICE_MS = 6000

export interface UseSavedNoticeReturn {
  message: string
  show: (message: string) => void
  dismiss: () => void
}

/**
 * CLIENTES-UX-1A — confirmación visible de un guardado exitoso.
 *
 * El diálogo de edición se cerraba y nada decía si los cambios habían
 * quedado. Esto sostiene el texto unos segundos; lo dibuja `SavedNotice`.
 */
export function useSavedNotice(durationMs = SAVED_NOTICE_MS): UseSavedNoticeReturn {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    setMessage('')
  }, [])

  const show = useCallback((text: string) => {
    clearTimeout(timer.current)
    setMessage(text)
    timer.current = setTimeout(() => setMessage(''), durationMs)
  }, [durationMs])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { message, show, dismiss }
}
