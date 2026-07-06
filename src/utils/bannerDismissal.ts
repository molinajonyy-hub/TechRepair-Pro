// Persistencia de "descartado" para avisos por-negocio. Extraído para poder
// testear el comportamiento real (no el texto fuente) sin un DOM.
export interface KVStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function bannerStorageKey(prefix: string, businessId?: string | null): string {
  return `${prefix}:${businessId || 'default'}`
}

export function isBannerDismissed(store: KVStore | undefined, key: string): boolean {
  try { return store?.getItem(key) === '1' } catch { return false }
}

export function dismissBanner(store: KVStore | undefined, key: string): void {
  try { store?.setItem(key, '1') } catch { /* almacenamiento no disponible: se ocultará sólo esta sesión */ }
}
