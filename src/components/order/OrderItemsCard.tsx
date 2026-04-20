import { useState, useEffect } from 'react'
import { Plus, Trash2, Package, Wrench, TrendingUp, Loader2, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ModalAgregarItem } from './ModalAgregarItem'

interface OrderItem {
  id: string
  tipo: 'repuesto' | 'servicio'
  descripcion: string
  cantidad: number
  precio_unitario: number
  costo_unitario: number
  cliente_paga_repuesto: boolean
  product_id?: string
  created_at: string
}

interface OrderItemsCardProps {
  orderId: string
  onTotalsChange?: () => void
}

export function OrderItemsCard({ orderId, onTotalsChange }: OrderItemsCardProps) {
  const [items, setItems] = useState<OrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    loadItems()
  }, [orderId])

  async function loadItems() {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: true })

      if (error) throw error
      setItems(data || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function deleteItem(itemId: string) {
    if (!confirm('¿Eliminar este ítem? El stock se restaurará automáticamente.')) return
    setDeletingId(itemId)
    try {
      const { error } = await supabase
        .from('order_items')
        .delete()
        .eq('id', itemId)

      if (error) throw error
      await loadItems()
      onTotalsChange?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  function handleItemAdded() {
    loadItems()
    onTotalsChange?.()
  }

  // Calculations
  const repuestos = items.filter(i => i.tipo === 'repuesto')
  const servicios = items.filter(i => i.tipo === 'servicio')

  const totalRepuestos = repuestos
    .filter(i => i.cliente_paga_repuesto)
    .reduce((s, i) => s + i.precio_unitario * i.cantidad, 0)

  const totalServicios = servicios
    .reduce((s, i) => s + i.precio_unitario * i.cantidad, 0)

  const totalCliente = totalRepuestos + totalServicios

  const costoTotal = items
    .reduce((s, i) => s + i.costo_unitario * i.cantidad, 0)

  const margen = totalCliente - costoTotal

  if (loading) {
    return (
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '2rem' }}>
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: '#6366f1' }} />
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <Package size={18} color="#6366f1" />
            Ítems de la orden
            <span style={{
              fontSize: '0.75rem', fontWeight: 600,
              backgroundColor: 'rgba(99,102,241,0.15)',
              color: '#818cf8',
              padding: '0.125rem 0.5rem',
              borderRadius: '99px'
            }}>
              {items.length}
            </span>
          </h3>
          <button
            onClick={() => setShowModal(true)}
            className="btn btn-sm btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}
          >
            <Plus size={15} />
            Agregar ítem
          </button>
        </div>

        <div className="card-body" style={{ padding: '0' }}>
          {error && (
            <div style={{
              margin: '1rem', padding: '0.75rem',
              backgroundColor: 'rgba(220,38,38,0.1)',
              borderRadius: '0.5rem', color: '#dc2626',
              fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem'
            }}>
              <AlertCircle size={15} />
              {error}
            </div>
          )}

          {items.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center' }}>
              <div style={{
                width: '56px', height: '56px', borderRadius: '50%',
                backgroundColor: 'rgba(99,102,241,0.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 1rem'
              }}>
                <Package size={24} color="#6366f1" />
              </div>
              <p style={{ color: '#64748b', margin: 0, fontSize: '0.9375rem' }}>
                Sin ítems aún
              </p>
              <p style={{ color: '#475569', margin: '0.25rem 0 1.25rem', fontSize: '0.8125rem' }}>
                Agregá repuestos y servicios para calcular el total automáticamente
              </p>
              <button
                onClick={() => setShowModal(true)}
                className="btn btn-sm btn-primary"
              >
                <Plus size={14} />
                Agregar primer ítem
              </button>
            </div>
          ) : (
            <>
              {/* Items list */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1e293b' }}>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>
                        Descripción
                      </th>
                      <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center', color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Cant.
                      </th>
                      <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        P. Unit.
                      </th>
                      <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Subtotal
                      </th>
                      <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Costo
                      </th>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>
                        —
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Servicios */}
                    {servicios.length > 0 && (
                      <>
                        <tr>
                          <td colSpan={6} style={{
                            padding: '0.5rem 1rem',
                            backgroundColor: '#0f172a',
                            fontSize: '0.75rem', fontWeight: 700,
                            color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em'
                          }}>
                            <Wrench size={12} style={{ display: 'inline', marginRight: '0.375rem' }} />
                            Servicios
                          </td>
                        </tr>
                        {servicios.map(item => (
                          <ItemRow key={item.id} item={item} onDelete={deleteItem} deletingId={deletingId} />
                        ))}
                      </>
                    )}
                    {/* Repuestos */}
                    {repuestos.length > 0 && (
                      <>
                        <tr>
                          <td colSpan={6} style={{
                            padding: '0.5rem 1rem',
                            backgroundColor: '#0f172a',
                            fontSize: '0.75rem', fontWeight: 700,
                            color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.06em'
                          }}>
                            <Package size={12} style={{ display: 'inline', marginRight: '0.375rem' }} />
                            Repuestos
                          </td>
                        </tr>
                        {repuestos.map(item => (
                          <ItemRow key={item.id} item={item} onDelete={deleteItem} deletingId={deletingId} />
                        ))}
                      </>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Totals summary */}
              <div style={{
                margin: '0 1rem 1rem',
                padding: '1rem',
                backgroundColor: '#0f172a',
                borderRadius: '0.625rem',
                display: 'flex', flexDirection: 'column', gap: '0.5rem'
              }}>
                {totalServicios > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span style={{ color: '#94a3b8' }}>Servicios</span>
                    <span style={{ color: '#f8fafc', fontWeight: 600 }}>${totalServicios.toLocaleString()}</span>
                  </div>
                )}
                {totalRepuestos > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span style={{ color: '#94a3b8' }}>Repuestos (al cliente)</span>
                    <span style={{ color: '#f8fafc', fontWeight: 600 }}>${totalRepuestos.toLocaleString()}</span>
                  </div>
                )}
                <div style={{ height: '1px', backgroundColor: '#1e293b', margin: '0.25rem 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, color: '#f8fafc' }}>Total al cliente</span>
                  <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#6366f1' }}>
                    ${totalCliente.toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                  <span style={{ color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <TrendingUp size={13} />
                    Margen bruto
                  </span>
                  <span style={{ color: margen >= 0 ? '#10b981' : '#dc2626', fontWeight: 600 }}>
                    ${margen.toLocaleString()}
                    {totalCliente > 0 && (
                      <span style={{ fontSize: '0.75rem', marginLeft: '0.375rem', opacity: 0.8 }}>
                        ({((margen / totalCliente) * 100).toFixed(1)}%)
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <ModalAgregarItem
        isOpen={showModal}
        orderId={orderId}
        onClose={() => setShowModal(false)}
        onItemAdded={handleItemAdded}
      />
    </>
  )
}

// ─── Row subcomponent ──────────────────────────────────────────────────────────
function ItemRow({
  item,
  onDelete,
  deletingId
}: {
  item: OrderItem
  onDelete: (id: string) => void
  deletingId: string | null
}) {
  const subtotal = item.precio_unitario * item.cantidad
  const costo = item.costo_unitario * item.cantidad
  const isDeleting = deletingId === item.id

  return (
    <tr style={{ borderBottom: '1px solid #1e293b' }}>
      <td style={{ padding: '0.75rem 1rem' }}>
        <p style={{ margin: 0, color: '#f8fafc', fontWeight: 500 }}>{item.descripcion}</p>
        {item.tipo === 'repuesto' && !item.cliente_paga_repuesto && (
          <span style={{ fontSize: '0.7rem', color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
            No cobrado al cliente
          </span>
        )}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center', color: '#94a3b8' }}>
        {item.cantidad}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#94a3b8' }}>
        ${item.precio_unitario.toLocaleString()}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#f8fafc', fontWeight: 600 }}>
        ${subtotal.toLocaleString()}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#64748b', fontSize: '0.8125rem' }}>
        ${costo.toLocaleString()}
      </td>
      <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
        <button
          onClick={() => onDelete(item.id)}
          disabled={isDeleting}
          style={{
            background: 'none', border: 'none',
            color: isDeleting ? '#374151' : '#dc2626',
            cursor: isDeleting ? 'not-allowed' : 'pointer',
            padding: '0.25rem'
          }}
        >
          {isDeleting
            ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
            : <Trash2 size={15} />
          }
        </button>
      </td>
    </tr>
  )
}
