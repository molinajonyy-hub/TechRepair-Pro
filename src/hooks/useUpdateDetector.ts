import { useState, useEffect, useRef } from 'react'

const CURRENT_BUILD = __BUILD_TIME__
const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutos

export function useUpdateDetector() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const checkedRef = useRef(false)

  const check = async () => {
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const { buildTime } = await res.json() as { buildTime: string }
      if (buildTime && buildTime !== CURRENT_BUILD) {
        setUpdateAvailable(true)
      }
    } catch { /* red no disponible, ignorar */ }
  }

  useEffect(() => {
    // Primera verificación diferida (no bloquear el render inicial)
    const init = setTimeout(() => { void check(); checkedRef.current = true }, 10_000)

    // Verificar al volver al tab
    const onFocus = () => { if (checkedRef.current) void check() }
    window.addEventListener('focus', onFocus)

    // Polling periódico
    const timer = setInterval(() => void check(), POLL_INTERVAL)

    return () => {
      clearTimeout(init)
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const reload = () => {
    // Limpiar caché de fetch/service worker si hubiera uno, luego recargar
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister())
        window.location.reload()
      })
    } else {
      window.location.reload()
    }
  }

  return { updateAvailable, reload }
}
