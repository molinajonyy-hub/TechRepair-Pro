import { useState, useEffect } from 'react'

/**
 * Detecta la altura del teclado virtual en iOS/Android usando visualViewport.
 * Retorna el desplazamiento en px que el teclado ocupa (0 si está cerrado).
 * Útil para mantener paneles flotantes visibles sobre el teclado.
 */
export function useKeyboardAwareBottomOffset(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      const offset = window.innerHeight - (vv.height + (vv.offsetTop ?? 0))
      // Threshold 80px to filter false positives (browser chrome, address bar changes)
      setKeyboardHeight(offset > 80 ? offset : 0)
    }

    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return keyboardHeight
}
