import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Trash2, Minus, Plus, MessageCircle, CheckCircle } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { usePortalCart } from '../hooks/usePortalCart'
import { usePortalGuard } from '../hooks/usePortalGuard'
import { createOrder, trackEvent } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PT } from '../components/PortalLayout'

function fmtARS(n: number) {
  return '$' + Math.round(n).toLocaleString('es-AR')
}

function buildWhatsAppMessage(params: {
  businessName: string
  orderNumber:  string
  customerName: string
  shopName:     string
  phone:        string
  items:        { name: string; qty: number; price: number }[]
  total:        number
  notes:        string
}): string {
  const lines = params.items
    .map(i => `• ${i.qty}x ${i.name} — ${fmtARS(i.price * i.qty)}`)
    .join('\n')

  return `Hola ${params.businessName} 👋
Quiero realizar este pedido mayorista:

Pedido Nº: ${params.orderNumber}

Cliente: ${params.customerName}
Negocio: ${params.shopName}
Teléfono: ${params.phone}

Productos:
${lines}

Total estimado: ${fmtARS(params.total)}${params.notes ? `\n\nObservaciones:\n${params.notes}` : ''}`
}

export function PortalCart() {
  usePortalGuard()
  const { slug } = useParams<{ slug: string }>()
  const { business, customer } = usePortal()
  const { items, total, updateQty, removeItem, clearCart } = usePortalCart(business?.id || '')
  const navigate = useNavigate()

  const [notes,     setNotes]     = useState('')
  const [loading,   setLoading]   = useState(false)
  const [success,   setSuccess]   = useState(false)
  const [orderNum,  setOrderNum]  = useState('')
  const [error,     setError]     = useState('')

  const handleSendWhatsApp = async () => {
    if (!business || !customer) return
    if (items.length === 0) return
    setLoading(true); setError('')

    const { order, error: err } = await createOrder({
      businessId: business.id,
      customerId: customer.id,
      items,
      notes,
    })

    if (err || !order) { setError(err || 'Error al crear el pedido'); setLoading(false); return }

    setOrderNum(order.order_number)

    await trackEvent(business.id, 'whatsapp_order', customer.id, { order_id: order.id, total })

    const waNumber = (business.wholesale_whatsapp || '').replace(/\D/g, '')
    const msg = buildWhatsAppMessage({
      businessName: business.name,
      orderNumber:  order.order_number,
      customerName: customer.name,
      shopName:     customer.business_name || customer.name,
      phone:        customer.whatsapp || '—',
      items:        items.map(i => ({ name: i.productName, qty: i.quantity, price: i.unitPrice })),
      total,
      notes,
    })

    setLoading(false)
    setSuccess(true)
    clearCart()

    const waUrl = waNumber
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`

    window.open(waUrl, '_blank')
  }

  if (success) {
    return (
      <PortalLayout title="Pedido enviado" showBack showCart={false} backTo={`/mayorista/${slug}/catalogo`}>
        <div style={{ padding: '3rem 1rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ width: 80, height: 80, borderRadius: '50%', background: `${PT.success}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={42} style={{ color: PT.success }} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.5rem' }}>¡Pedido enviado!</h2>
            <p style={{ color: PT.textSub, margin: '0 0 0.25rem' }}>Pedido Nº <strong>{orderNum}</strong></p>
            <p style={{ color: PT.textSub, fontSize: '0.9rem', margin: 0 }}>
              Se abrió WhatsApp con el mensaje del pedido. Pronto te confirmamos.
            </p>
          </div>
          <PortalButton variant="secondary" onClick={() => navigate(`/mayorista/${slug}/catalogo`)}>
            Volver al catálogo
          </PortalButton>
        </div>
      </PortalLayout>
    )
  }

  if (items.length === 0) {
    return (
      <PortalLayout title="Mi pedido" showBack showCart={false} backTo={`/mayorista/${slug}/catalogo`}>
        <div style={{ padding: '3rem 1rem', textAlign: 'center' }}>
          <p style={{ fontSize: '2rem', marginBottom: '1rem' }}>🛒</p>
          <p style={{ color: PT.textSub }}>Tu pedido está vacío.</p>
          <PortalButton onClick={() => navigate(`/mayorista/${slug}/catalogo`)}>
            Ver catálogo
          </PortalButton>
        </div>
      </PortalLayout>
    )
  }

  return (
    <PortalLayout title="Mi pedido" showBack showCart={false} backTo={`/mayorista/${slug}/catalogo`}>
      <div style={{ padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

        {/* Items */}
        <PortalCard>
          {items.map((item, i) => (
            <div key={item.inventoryItemId} style={{
              padding: '0.875rem 1rem',
              borderBottom: i < items.length - 1 ? `1px solid ${PT.border}` : 'none',
              display: 'flex', alignItems: 'center', gap: '0.875rem',
            }}>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 0.2rem', fontWeight: 600, fontSize: '0.9rem' }}>{item.productName}</p>
                <p style={{ margin: 0, color: PT.textSub, fontSize: '0.8rem', fontFamily: 'monospace' }}>
                  {fmtARS(item.unitPrice)} c/u
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                <button onClick={() => updateQty(item.inventoryItemId, item.quantity - 1)}
                  style={{ width: 32, height: 32, borderRadius: '50%', border: `1px solid ${PT.border}`, background: PT.bg, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: PT.text }}>
                  <Minus size={14} />
                </button>
                <span style={{ minWidth: 24, textAlign: 'center', fontWeight: 700, fontSize: '1rem' }}>{item.quantity}</span>
                <button
                  onClick={() => updateQty(item.inventoryItemId, Math.min(item.quantity + 1, item.stock))}
                  disabled={item.quantity >= item.stock}
                  style={{ width: 32, height: 32, borderRadius: '50%', border: `1px solid ${PT.border}`, background: item.quantity >= item.stock ? PT.border : PT.bg, cursor: item.quantity >= item.stock ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: PT.text }}>
                  <Plus size={14} />
                </button>
              </div>

              <div style={{ flexShrink: 0, minWidth: 80, textAlign: 'right' }}>
                <p style={{ margin: 0, fontWeight: 700, fontFamily: 'monospace' }}>{fmtARS(item.unitPrice * item.quantity)}</p>
              </div>

              <button onClick={() => removeItem(item.inventoryItemId)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: PT.danger, padding: '0.25rem' }}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </PortalCard>

        {/* Notes */}
        <PortalCard style={{ padding: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: PT.textSub, marginBottom: '0.5rem' }}>
            Observaciones (opcional)
          </label>
          <textarea
            value={notes} onChange={e => setNotes(e.target.value)}
            rows={3} placeholder="Aclaraciones sobre el pedido, envío, etc."
            style={{ width: '100%', boxSizing: 'border-box', padding: '0.75rem 1rem', background: PT.bg, border: `1px solid ${PT.border}`, borderRadius: PT.radius, color: PT.text, fontFamily: PT.font, fontSize: '0.95rem', outline: 'none', resize: 'vertical' }}
          />
        </PortalCard>

        {/* Total */}
        <PortalCard style={{ padding: '1rem 1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.9rem', color: PT.textSub, fontWeight: 600 }}>{items.reduce((s, i) => s + i.quantity, 0)} productos</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '-0.02em' }}>{fmtARS(total)}</span>
          </div>
          <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: PT.textSub }}>
            Precio mayorista · El total es orientativo hasta confirmar disponibilidad
          </p>
        </PortalCard>

        {error && (
          <div style={{ padding: '0.875rem 1rem', background: `${PT.danger}15`, border: `1px solid ${PT.danger}40`, borderRadius: PT.radius, color: PT.danger, fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        <PortalButton loading={loading} onClick={handleSendWhatsApp}>
          <MessageCircle size={20} />
          Enviar pedido por WhatsApp
        </PortalButton>

        <p style={{ margin: 0, textAlign: 'center', color: PT.textSub, fontSize: '0.78rem' }}>
          El pedido se guarda y se abre WhatsApp con el resumen listo para enviar.
        </p>
      </div>
    </PortalLayout>
  )
}
