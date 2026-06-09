import type { SearchField } from '../../utils/searchUtils'

export type { SearchField }

export interface SearchAdapter<T> {
  fields: SearchField<T>[]
  getLabel?: (item: T) => string
}

export type SearchConfidence = 'exact' | 'high' | 'medium' | 'low'

export interface UseSmartSearchOptions<T> {
  query: string
  items: T[]
  adapter: SearchAdapter<T>
  limit?: number
  minScore?: number
  debounceMs?: number
}
