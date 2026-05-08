import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MessageCircle, ChevronDown, ChevronUp, Package } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { getCustomerOrders } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PT } from '../components/PortalLayout'
import { ORDER_STATUS_LABEL, ORDER_STATUS_COLOR } from '../types'
import type { WholesaleOrder } from '../types'

function fmtARS(n: number) {
  return '$' + Math.round(n).toLocaleString('es-AR')
}

function OrderRow({ order, businessWa }: { order: WholesaleOrder; businessWa: string | null }) {
  const [open, setOpen] = useState(false)

  const waMsg = encodeURIComponent(
    `Hola! Quiero consultar el estado de mi pedido #${order.order_number}.`
  )
  const waUrl = businessWa
    ? `https://wa.me/${businessWa.replace(/\D/g, '')}?text=${waMsg}`
    : `https://wa.me/?text=${waMsg}`

  return (
    <div style={{ background: PT.surface, borderRadius: PT.radiusLg, overflow: 'hidden', boxShadow: PT.shadow }}>
      {/* Header row */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: '100%', padding: '1rem 1.125rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.25rem' }}>
            <span style={{ fontWeight: 700, fontSize: '0.9rem', color: PT.text }}>#{order.order_number}</span>
            <span style={{
              padding: '0.15rem 0.5rem', borderRadius: '99px', fontSize: '0.68rem', fontWeight: 700,
              background: `${ORDER_STATUS_COLOR[order.status]}15`,
              color: ORDER_STATUS_COLOR[order.status],
              border: `1px solid ${ORDER_STATUS_COLOR[order.status]}35`,
            }}>
              {ORDER_STATUS_LABEL[order.status]}
            </span>
          </div>
          <div style={{ fontSize: '0.78rem', color: PT.textSub }}>
            {new Date(order.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })}
            {' · '}
            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: PT.text }}>{fmtARS(order.total)}</span>
          </div>
        </div>
        {open ? <ChevronUp size={16} style={{ color: PT.textSub, flexShrink: 0 }} /> : <ChevronDown size={16} style={{ color: PT.textSub, flexShrink: 0 }} />}
      </button>

      {/* Expanded detail */}
      {open && (
        <div style={{ borderTop: `1px solid ${PT.border}` }}>
          {/* Items */}
          {order.items && order.items.length > 0 && (
            <div style={{ padding: '0.75rem 1.125rem' }}>
              {order.items.map(item => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', fontSize: '0.85rem', borderBottom: `1px solid ${PT.border}` }}>
                  <span style={{ color: PT.text }}>{item.quantity}× {item.product_name}</span>
                  <span style={{ fontFamily: 'monospace', color: PT.text, fontWeight: 600 }}>{fmtARS(item.subtotal)}</span>
                </div>
              ))}
              {order.notes && (
                <p style={{ margin: '0.625rem 0 0', fontSize: '0.78rem', color: PT.textSub, fontStyle: 'italic' }}>
                  Obs: {order.notes}
                </p>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.625rem', fontWeight: 700 }}>
                <span style={{ color: PT.textSub, fontSize: '0.85rem' }}>Total</span>
                <span style={{ fontFamily: 'monospace', fontSize: '1rem' }}>{fmtARS(order.total)}</span>
              </div>
            </div>
          )}
          {/* WA button */}
          <div style={{ padding: '0.75rem 1.125rem', borderTop: `1px solid ${PT.border}` }}>
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.625rem 1rem', background: `${PT.success}15`, border: `1px solid ${PT.success}35`, borderRadius: PT.radius, color: PT.success, fontFamily: PT.font, fontSize: '0.875rem', fontWeight: 600 }}
            >
              <MessageCircle size={16} /> Consultar por WhatsApp
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

export function PortalOrders() {
  const { slug } = useParams<{ slug: string }>()
  const { business, customer } = usePortal()
  const navigate = useNavigate()
  const [orders,  setOrders]  = useState<WholesaleOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!customer) return
    getCustomerOrders(customer.id).then(list => { setOrders(list); setLoading(false) })
  }, [customer])

  return (
    <PortalLayout title="Mis pedidos" showBack showCart backTo={`/mayorista/${slug}/catalogo`}>
      <div style={{ padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {loading ? (
          <PortalCard style={{ padding: '3rem', textAlign: 'center' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', border: `3px solid ${PT.primary}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </PortalCard>
        ) : orders.length === 0 ? (
          <PortalCard style={{ padding: '3rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <Package size={36} style={{ color: PT.textSub, opacity: 0.5 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 600, color: PT.text }}>Sin pedidos aún</p>
              <p style={{ margin: '0.375rem 0 0', color: PT.textSub, fontSize: '0.875rem' }}>Cuando hagas tu primer pedido aparecerá acá.</p>
            </div>
            <PortalButton onClick={() => navigate(`/mayorista/${slug}/catalogo`)} fullWidth={false}>
              Ver catálogo
            </PortalButton>
          </PortalCard>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '0.8rem', color: PT.textSub, padding: '0 0.25rem' }}>
              {orders.length} pedido{orders.length !== 1 ? 's' : ''}
            </p>
            {orders.map(o => (
              <OrderRow key={o.id} order={o} businessWa={business?.wholesale_whatsapp ?? null} />
            ))}
          </>
        )}
      </div>
    </PortalLayout>
  )
}
