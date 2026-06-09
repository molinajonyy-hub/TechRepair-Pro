import { useState, useEffect, useMemo } from 'react'
import { smartSearch } from '../../utils/searchUtils'
import type { UseSmartSearchOptions } from './searchTypes'

/**
 * Hook de búsqueda inteligente con debounce y memoización.
 * Usa el algoritmo cross-field AND de smartSearch.
 */
export function useSmartSearch<T>({
  query,
  items,
  adapter,
  limit,
  minScore: _minScore,
  debounceMs = 150,
}: UseSmartSearchOptions<T>): { results: T[]; isSearching: boolean } {
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    if (!query.trim()) {
      setDebouncedQuery('')
      return
    }
    const timer = setTimeout(() => setDebouncedQuery(query), debounceMs)
    return () => clearTimeout(timer)
  }, [query, debounceMs])

  const results = useMemo(() => {
    const filtered = smartSearch(items, debouncedQuery, adapter.fields)
    return limit != null ? filtered.slice(0, limit) : filtered
  }, [debouncedQuery, items, adapter.fields, limit])

  const isSearching = query.trim() !== debouncedQuery.trim()

  return { results, isSearching }
}
