import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, Wrench, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'

interface PreviewRow {
  source: string
  sale_id: string
  item_id: string
  inventory_id: string
  product_name: string
  quantity: number
  current_stock: number
  can_deduct: boolean
  sale_date: string
}

interface RepairResult {
  comprobantes_procesados: number
  pedidos_mayoristas_procesados: number
  items_sin_stock_suficiente: number
  items_producto_no_encontrado: number
  total_unidades_descontadas: number
}

export function StockRepairTool() {
  const { businessId, profile } = useAuth()
  const [preview, setPreview]     = useState<PreviewRow[] | null>(null)
  const [result,  setResult]      = useState<RepairResult | null>(null)
  const [loading, setLoading]     = useState(false)
  const [confirm, setConfirm]     = useState(false)
  const [allowNeg, setAllowNeg]   = useState(false)
  const [error,   setError]       = useState('')

  const isAdmin = ['owner', 'admin'].includes(profile?.role || '')
  if (!isAdmin) return null

  const handlePreview = async () => {
    if (!businessId) return
    setLoading(true); setError(''); setPreview(null); setResult(null); setConfirm(false)
    try {
      const { data, error: rpcErr } = await supabase
        .rpc('preview_missing_stock_movements', { p_business_id: businessId })
      if (rpcErr) throw rpcErr
      setPreview((data as PreviewRow[]) || [])
    } catch (e: any) {
      setError(e.message || 'Error al obtener preview')
    } finally {
      setLoading(false)
    }
  }

  const handleRepair = async () => {
    if (!businessId || !confirm) return
    setLoading(true); setError(''); setResult(null)
    try {
      const { data, error: rpcErr } = await supabase
        .rpc('repair_missing_stock_movements', {
          p_business_id:    businessId,
          p_allow_negative: allowNeg,
        })
      if (rpcErr) throw rpcErr
      setResult(data as RepairResult)
      setPreview(null)
      setConfirm(false)
    } catch (e: any) {
      setError(e.message || 'Error al reparar stock')
    } finally {
      setLoading(false)
    }
  }

  const candeducable = preview?.filter(r => r.can_deduct).length ?? 0
  const sinStock     = preview?.filter(r => !r.can_deduct).length ?? 0

  return (
    <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <Wrench size={20} color="#f59e0b" />
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
            Reparar stock de ventas anteriores
          </h3>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: '#64748b' }}>
            Descuenta stock de ventas ya realizadas que no impactaron en inventario
          </p>
        </div>
      </div>

      {/* Opciones */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={allowNeg}
          onChange={e => setAllowNeg(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: '#f59e0b' }}
        />
        <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          Permitir stock negativo (procesar aunque no haya stock suficiente)
        </span>
      </label>

      {/* Acciones */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          onClick={handlePreview}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.4rem',
            padding: '0.6rem 1.125rem', borderRadius: 8, border: 'none',
            background: 'rgba(99,102,241,0.15)', color: '#818cf8',
            fontWeight: 600, fontSize: '0.875rem', cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading && !confirm ? <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Eye size={15} />}
          Analizar ventas sin descontar
        </button>

        {preview !== null && preview.length > 0 && (
          <button
            onClick={() => setConfirm(true)}
            disabled={loading || candeducable === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.6rem 1.125rem', borderRadius: 8, border: 'none',
              background: candeducable > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.05)',
              color: candeducable > 0 ? '#f59e0b' : '#475569',
              fontWeight: 600, fontSize: '0.875rem',
              cursor: candeducable > 0 && !loading ? 'pointer' : 'not-allowed',
            }}
          >
            <Wrench size={15} />
            Aplicar corrección ({candeducable} items)
          </button>
        )}
      </div>

      {/* Preview */}
      {preview !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {preview.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.875rem 1rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 10, color: '#22c55e', fontSize: '0.875rem', fontWeight: 600 }}>
              <CheckCircle2 size={16} /> Todo el stock está al día. No hay ventas pendientes de procesar.
            </div>
          ) : (
            <>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                <strong style={{ color: '#f1f5f9' }}>{preview.length}</strong> items encontrados —{' '}
                <span style={{ color: '#22c55e' }}>{candeducable} con stock suficiente</span>
                {sinStock > 0 && <>, <span style={{ color: '#ef4444' }}>{sinStock} sin stock suficiente</span></>}
              </div>

              <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {preview.map(row => (
                  <div key={row.item_id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    padding: '0.5rem 0.875rem',
                    background: row.can_deduct ? 'rgba(255,255,255,0.03)' : 'rgba(239,68,68,0.06)',
                    border: `1px solid ${row.can_deduct ? 'rgba(255,255,255,0.06)' : 'rgba(239,68,68,0.2)'}`,
                    borderRadius: 8, fontSize: '0.8rem',
                  }}>
                    <span style={{ color: '#64748b', minWidth: 90 }}>
                      {row.source === 'comprobante' ? 'Comprobante' : 'Pedido mayorista'}
                    </span>
                    <span style={{ flex: 1, color: '#f1f5f9', fontWeight: 500 }}>{row.product_name}</span>
                    <span style={{ color: '#94a3b8' }}>x{row.quantity}</span>
                    <span style={{ color: row.can_deduct ? '#22c55e' : '#ef4444', minWidth: 80, textAlign: 'right' }}>
                      Stock actual: {row.current_stock}
                    </span>
                    <span style={{ color: '#475569', minWidth: 90, textAlign: 'right' }}>
                      {new Date(row.sale_date).toLocaleDateString('es-AR')}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Confirmación */}
      {confirm && (
        <div style={{ padding: '1rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#fcd34d', lineHeight: 1.5 }}>
              Esta operación va a descontar stock de <strong>{candeducable}</strong> items de inventario.
              No se puede deshacer automáticamente. ¿Confirmar?
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.625rem' }}>
            <button
              onClick={handleRepair}
              disabled={loading}
              style={{
                padding: '0.5rem 1rem', borderRadius: 8, border: 'none',
                background: '#f59e0b', color: '#1c1917', fontWeight: 700, fontSize: '0.875rem',
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
                display: 'flex', alignItems: 'center', gap: '0.375rem',
              }}
            >
              {loading ? <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> : null}
              Sí, aplicar corrección
            </button>
            <button
              onClick={() => setConfirm(false)}
              style={{ padding: '0.5rem 1rem', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Resultado */}
      {result && (
        <div style={{ padding: '1rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: '#22c55e', marginBottom: '0.25rem' }}>
            <CheckCircle2 size={16} /> Reparación completada
          </div>
          {[
            ['Comprobantes procesados',       result.comprobantes_procesados],
            ['Pedidos mayoristas procesados', result.pedidos_mayoristas_procesados],
            ['Unidades descontadas',          result.total_unidades_descontadas],
            ['Sin stock suficiente (omitidos)', result.items_sin_stock_suficiente],
            ['Producto no encontrado (omitidos)', result.items_producto_no_encontrado],
          ].map(([label, value]) => (
            <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
              <span style={{ color: '#94a3b8' }}>{label}</span>
              <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, color: '#ef4444', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
