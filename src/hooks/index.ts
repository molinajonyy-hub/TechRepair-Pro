import { useState, useEffect } from 'react'
import { ordersService, customersService } from '../services/api'

// Hook for orders
export function useOrders() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadOrders()
  }, [])

  async function loadOrders() {
    try {
      setLoading(true)
      const data = await ordersService.getAll()
      setOrders(data || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  return { orders, loading, error, refresh: loadOrders }
}

// Hook for single order
export function useOrder(id: string) {
  const [order, setOrder] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id) {
      loadOrder()
    }
  }, [id])

  async function loadOrder() {
    try {
      setLoading(true)
      const data = await ordersService.getById(id)
      setOrder(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  async function updateStatus(
    status: Parameters<typeof ordersService.updateStatus>[1],
    note?: string
  ) {
    try {
      await ordersService.updateStatus(id, status, note)
      await loadOrder()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    }
  }

  return { order, loading, error, refresh: loadOrder, updateStatus }
}

// Hook for customers
export function useCustomers() {
  const [customers, setCustomers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadCustomers()
  }, [])

  async function loadCustomers() {
    try {
      setLoading(true)
      const data = await customersService.getAll()
      setCustomers(data || [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  return { customers, loading, error, refresh: loadCustomers }
}

// Hook for search
export function useSearch<T>(
  searchFn: (query: string) => Promise<T[]>,
  debounceMs: number = 300
) {
  const [results, setResults] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const timeout = setTimeout(async () => {
      if (query.trim()) {
        setLoading(true)
        try {
          const data = await searchFn(query)
          setResults(data)
        } catch (err) {
          setResults([])
        } finally {
          setLoading(false)
        }
      } else {
        setResults([])
      }
    }, debounceMs)

    return () => clearTimeout(timeout)
  }, [query, searchFn, debounceMs])

  return { query, setQuery, results, loading }
}

// Hook for form state
export function useFormState<T extends Record<string, any>>(initialState: T) {
  const [values, setValues] = useState<T>(initialState)
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (field: keyof T, value: any) => {
    setValues(prev => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: undefined }))
    }
  }

  const setError = (field: keyof T, message: string) => {
    setErrors(prev => ({ ...prev, [field]: message }))
  }

  const reset = () => {
    setValues(initialState)
    setErrors({})
    setIsSubmitting(false)
  }

  return {
    values,
    errors,
    isSubmitting,
    setIsSubmitting,
    handleChange,
    setError,
    reset,
    setValues
  }
}

// Exportar useComprobantes
export { useComprobantes, facturacionService, afipService } from './useComprobantes';
export type { TipoComprobante, Comprobante, ComprobanteItem } from './useComprobantes';
