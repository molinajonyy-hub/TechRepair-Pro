export type { SearchAdapter, SearchField, SearchConfidence, UseSmartSearchOptions } from './searchTypes'
export { SEARCH_SYNONYMS, expandToken } from './searchSynonyms'
export {
  productSearchAdapter,
  customerSearchAdapter,
  orderSearchAdapter,
  comprobanteSearchAdapter,
  supplierSearchAdapter,
} from './entityAdapters'
export type {
  ProductSearchItem,
  CustomerSearchItem,
  OrderSearchItem,
  ComprobanteSearchItem,
  SupplierSearchItem,
} from './entityAdapters'
export { useSmartSearch } from './useSmartSearch'
