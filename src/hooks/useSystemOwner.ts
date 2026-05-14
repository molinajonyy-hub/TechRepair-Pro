import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

let _cachedEmail: string | null = null
let _cachedResult: boolean = false

export function useSystemOwner() {
  const { user, loading: authLoading, profileLoading } = useAuth()
  const email = user?.email?.toLowerCase() ?? null

  // Mientras auth esté cargando → loading = true para no redirigir prematuramente
  const authReady = !authLoading && !profileLoading

  const [isSystemOwner, setIsSystemOwner] = useState<boolean>(
    authReady && email !== null && email === _cachedEmail ? _cachedResult : false
  )
  const [loading, setLoading] = useState(true)  // siempre empieza cargando

  useEffect(() => {
    // No actuar hasta que auth esté completamente cargado
    if (!authReady) return

    if (!email) {
      setIsSystemOwner(false)
      setLoading(false)
      return
    }

    // Cache hit
    if (email === _cachedEmail) {
      setIsSystemOwner(_cachedResult)
      setLoading(false)
      return
    }

    // DB query
    setLoading(true)
    supabase
      .from('system_admins')
      .select('email')
      .eq('email', email)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.warn('[useSystemOwner] query error:', error)
        const result = data !== null
        _cachedEmail  = email
        _cachedResult = result
        setIsSystemOwner(result)
        setLoading(false)
      })
  }, [authReady, email])

  return { isSystemOwner, loading }
}
