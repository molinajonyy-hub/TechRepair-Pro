export type DisplayStatusKey = 'borrador' | 'cobrado_pendiente_arca' | 'emitido_arca' | 'error_arca' | 'anulado'

export interface ComprobanteForDisplay {
  estado?: string | null
  estado_fiscal?: string | null
  cae?: string | null
  numero_fiscal?: string | null
  total_cobrado?: number | null
}

export interface ComprobanteDisplayStatus {
  key: DisplayStatusKey
  label: string
  color: string
  bgColor: string
}

export function getComprobanteDisplayStatus(c: ComprobanteForDisplay): ComprobanteDisplayStatus {
  if (c.estado === 'anulado' || c.estado_fiscal === 'anulado_fiscal') {
    return { key: 'anulado', label: 'Anulado', color: '#f87171', bgColor: 'rgba(239,68,68,0.1)' }
  }
  if (c.cae || c.estado_fiscal === 'emitido' || c.estado === 'emitido') {
    return { key: 'emitido_arca', label: 'Emitido ARCA', color: '#34d399', bgColor: 'rgba(16,185,129,0.1)' }
  }
  if (c.estado_fiscal === 'error_emision') {
    return { key: 'error_arca', label: 'Error ARCA', color: '#f87171', bgColor: 'rgba(239,68,68,0.1)' }
  }
  const cobrado = typeof c.total_cobrado === 'number' ? c.total_cobrado : 0
  if (cobrado > 0 && !c.cae && !c.numero_fiscal) {
    return { key: 'cobrado_pendiente_arca', label: 'Cobrado / Pendiente ARCA', color: '#60a5fa', bgColor: 'rgba(96,165,250,0.1)' }
  }
  return { key: 'borrador', label: 'Borrador', color: '#fbbf24', bgColor: 'rgba(245,158,11,0.1)' }
}
