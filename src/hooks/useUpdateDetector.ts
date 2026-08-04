import { useState, useEffect, useRef } from 'react'

const CURRENT_BUILD = __BUILD_TIME__
const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutos

/**
 * Recarga dura: desregistra el service worker (si lo hubiera) y recarga.
 *
 * Exportada aparte del hook para que la pantalla de error del portal mayorista
 * pueda ofrecer «Actualizar» sin montar un segundo detector de versión —el
 * portal ya monta `UpdateBanner`, que es el único poller—. Es siempre
 * disparada por el usuario: no hay recarga automática, así que no puede entrar
 * en un loop de reload.
 */
export function hardReload() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister())
      window.location.reload()
    })
  } else {
    window.location.reload()
  }
}

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

  return { updateAvailable, reload: hardReload }
}
