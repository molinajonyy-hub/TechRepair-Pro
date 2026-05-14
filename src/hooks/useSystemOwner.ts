import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

let _cachedEmail: string | null = null
let _cachedResult: boolean = false

export function useSystemOwner() {
  const { user } = useAuth()
  const email = user?.email?.toLowerCase() ?? null

  const [isSystemOwner, setIsSystemOwner] = useState<boolean>(
    // Reutilizar cache si el email coincide
    email !== null && email === _cachedEmail ? _cachedResult : false
  )
  const [loading, setLoading] = useState(
    email !== null && email === _cachedEmail ? false : email !== null
  )

  useEffect(() => {
    if (!email) { setIsSystemOwner(false); setLoading(false); return }
    if (email === _cachedEmail) { setIsSystemOwner(_cachedResult); setLoading(false); return }

    setLoading(true)
    supabase
      .from('system_admins')
      .select('email')
      .eq('email', email)
      .maybeSingle()
      .then(({ data }) => {
        const result = data !== null
        _cachedEmail  = email
        _cachedResult = result
        setIsSystemOwner(result)
        setLoading(false)
      })
  }, [email])

  return { isSystemOwner, loading }
}
