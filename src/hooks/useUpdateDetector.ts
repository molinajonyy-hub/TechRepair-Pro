import { useState, useEffect, useRef } from 'react'

const CURRENT_BUILD = __BUILD_TIME__
const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutos

/**
 * Recarga explícita: espera registros antiguos de SW y navega con URL nueva.
 *
 * Exportada aparte del hook para que la pantalla de error del portal mayorista
 * pueda ofrecer «Actualizar» sin montar un segundo detector de versión —el
 * portal ya monta `UpdateBanner`, que es el único poller—. Es siempre
 * disparada por el usuario: no hay recarga automática, así que no puede entrar
 * en un loop de reload.
 */
export async function hardReload() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map(registration => registration.unregister()))
  }
  // A fresh navigation escapes an old document/asset cache without deleting
  // session storage, local drafts, IndexedDB, or unrelated CacheStorage data.
  const destination = new URL(window.location.href)
  destination.searchParams.set('_tr_update', String(Date.now()))
  window.location.replace(destination.href)
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
