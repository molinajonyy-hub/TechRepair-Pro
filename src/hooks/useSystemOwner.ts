import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

let _cachedUserId: string | null = null
let _cachedResult: boolean = false

export function useSystemOwner() {
  const { user, loading: authLoading, profileLoading } = useAuth()
  const userId = user?.id ?? null

  const authReady = !authLoading && !profileLoading

  const [isSystemOwner, setIsSystemOwner] = useState<boolean>(
    authReady && userId !== null && userId === _cachedUserId ? _cachedResult : false
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authReady) return

    if (!userId) {
      setIsSystemOwner(false)
      setLoading(false)
      return
    }

    // Cache hit
    if (userId === _cachedUserId) {
      setIsSystemOwner(_cachedResult)
      setLoading(false)
      return
    }

    // Query por user_id (RLS: user_id = auth.uid())
    setLoading(true)
    supabase
      .from('system_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          if (process.env.NODE_ENV !== 'production') console.warn('[SYSTEM_OWNER_ERROR]', error)
          // Fail safe: no romper la app ni bloquear ventanas normales
          setIsSystemOwner(false)
          setLoading(false)
          return
        }
        const result = data !== null
        _cachedUserId  = userId
        _cachedResult  = result
        setIsSystemOwner(result)
        setLoading(false)
      })
  }, [authReady, userId])

  return { isSystemOwner, loading }
}
