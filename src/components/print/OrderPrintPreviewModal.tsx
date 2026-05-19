import React, { useRef, useState, useEffect } from 'react'
import { Printer } from 'lucide-react'
import { CloseButton } from '../ui/CloseButton'
import { ServiceOrderPrint, ServiceOrderData, PrintOrderItem } from './ServiceOrderPrint'
import { OrderDetailSimple } from '../../hooks/useOrderSimple'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useOrderPrintSettings } from '../../hooks/useOrderPrintSettings'
import { buildOrderPrintTitle } from '../../lib/printFilename'

interface OrderPrintPreviewModalProps {
  isOpen: boolean
  onClose: () => void
  order: OrderDetailSimple | null
}

function mapOrderToServiceData(order: OrderDetailSimple, orderItems?: PrintOrderItem[]): ServiceOrderData {
  return {
    id: order.id,
    created_at: order.created_at,
    status: order.status,
    technician: order.technician?.name,
    customer: {
      name: order.customer?.name || '—',
      phone: order.customer?.phone,
      email: order.customer?.email,
      address: order.customer?.address,
      dni: (order.customer as any)?.dni,
    },
    device: {
      type: order.device?.type,
      brand: order.device?.brand,
      model: order.device?.model,
      serial: order.device?.serial,
      imei: order.device?.imei,
      color: (order.device as any)?.color,
      password: (order.device as any)?.password,
      accessories: (order.device as any)?.accessories,
      aesthetic_condition: (order.device as any)?.aesthetic_condition,
    },
    reported_issue: order.device?.issue || (order as any)?.reported_issue,
    diagnosis: order.device?.diagnosis || (order as any)?.diagnosis,
    labor: (order as any)?.labor,
    parts_used: order.parts?.map(p => `${p.name}${p.quantity > 1 ? ` x${p.quantity}` : ''}`).join(', '),
    observations: order.notes || (order as any)?.observations,
    estimated_total: order.estimated_total,
    final_total: order.total_cost,
    orderItems: orderItems && orderItems.length > 0 ? orderItems : undefined,
  }
}

// A4 en px @ 96dpi: 794 × 1123
const PAGE_W = 794
const SCALE = 0.82
const VISUAL_W = Math.round(PAGE_W * SCALE) // 651px

export const OrderPrintPreviewModal: React.FC<OrderPrintPreviewModalProps> = ({
  isOpen,
  onClose,
  order,
}) => {
  const printRef = useRef<HTMLDivElement>(null)
  const [orderItems, setOrderItems] = useState<PrintOrderItem[]>([])
  const { businessId } = useAuth()
  const { settings } = useOrderPrintSettings(businessId)

  // Fetch order_items when modal opens — reset al cerrar
  useEffect(() => {
    if (!isOpen) { setOrderItems([]); return }
    if (!order?.id) return
    supabase
      .from('order_items')
      .select('tipo, descripcion, cantidad, precio_unitario, cliente_paga_repuesto')
      .eq('order_id', order.id)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          if (import.meta.env.DEV) console.warn('[PrintModal] Error cargando ítems:', error.message)
          return
        }
        if (data) setOrderItems(data as PrintOrderItem[])
      })
  }, [isOpen, order?.id])

  const handlePrint = () => {
    if (!printRef.current || !order) return
    const html = printRef.current.innerHTML
    const win = window.open('', '_blank')
    if (!win) return
    const bizName = settings.nombre_comercial || settings.razon_social || null
    const title = buildOrderPrintTitle(bizName, order.id)
    win.document.write(
      `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">` +
      `<title>${title}</title>` +
      `<style>@page{size:A4 portrait;margin:0}body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>` +
      `</head><body style="margin:0;padding:0">${html}</body></html>`
    )
    win.document.close()
    win.addEventListener('load', () => { win.print(); win.close() }, { once: true })
    setTimeout(() => { if (!win.closed) { win.print(); win.close() } }, 800)
  }

  if (!isOpen || !order) return null

  const serviceData = mapOrderToServiceData(order, orderItems)

  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: '1rem',
    }}>
      <div style={{
        backgroundColor: '#0f172a',
        borderRadius: '1rem',
        border: '1px solid rgba(255,255,255,0.08)',
        width: `${VISUAL_W + 48}px`,
        maxWidth: '96vw',
        maxHeight: '94vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.875rem 1.25rem',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
              Vista previa — Orden de Servicio
            </h2>
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.15rem 0 0 0' }}>
              #{order.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Preview scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '1.25rem',
          backgroundColor: '#060d1a',
          display: 'flex',
          justifyContent: 'center',
        }}>
          {/*
            Outer: define el espacio visual que ocupa en el layout (VISUAL_W × altura proporcional)
            Inner: ancho real (794px) escalado con transform
            El height del outer = height real del contenido × SCALE, pero como el contenido
            puede variar, usamos un wrapper con overflow visible y dejamos que el scroll externo maneje.
          */}
          {/*
            position:relative + height fijo en el outer → ocupa solo el espacio visual
            position:absolute en el inner → no afecta el flujo del layout
          */}
          <div style={{
            position: 'relative',
            width: `${VISUAL_W}px`,
            height: `${Math.round(1123 * SCALE)}px`,   // altura visual A4 ≈ 921px
            flexShrink: 0,
          }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: `${PAGE_W}px`,
              transformOrigin: 'top left',
              transform: `scale(${SCALE})`,
            }}>
              <div ref={printRef}>
                {/* Pass already-loaded settings to avoid duplicate DB call and
                    race condition where the child hook could show DEFAULT 'Mi Negocio'
                    while its own async load is in flight. */}
                <ServiceOrderPrint order={serviceData} previewMode printSettings={settings} />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: '0.625rem',
          padding: '0.875rem 1.25rem',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}>
          <button
            onClick={() => handlePrint()}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '0.5rem', padding: '0.625rem',
              backgroundColor: '#6366f1', border: 'none',
              color: '#ffffff', borderRadius: '0.5rem',
              cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
            }}
          >
            <Printer size={16} />
            Imprimir
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '0.625rem 1.25rem',
              backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#94a3b8', borderRadius: '0.5rem',
              cursor: 'pointer', fontSize: '0.875rem',
            }}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
