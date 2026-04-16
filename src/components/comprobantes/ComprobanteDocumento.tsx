/**
 * ComprobanteDocumento — plantilla visual completa del comprobante.
 * Se usa tanto en la página /comprobantes/:id como en la vista previa
 * del panel de configuración. Acepta los datos del negocio (profile)
 * y los datos del comprobante por props.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import {
  Plus, Trash2, Edit2, Check, X, Package,
  Phone, Instagram, Mail, MapPin,
} from 'lucide-react'
import { TipoComprobante, Comprobante, ComprobanteItem } from '../../hooks/useComprobantes'
import { OrderPrintSettings } from '../../hooks/useOrderPrintSettings'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Cliente {
  id: string; name: string; cuit?: string;
  condicion_fiscal?: string; address?: string; email?: string; phone?: string
}

interface Orden { id: string; order_number: string }

export interface ComprobanteDocumentoProps {
  comprobante: Comprobante
  items: ComprobanteItem[]
  cliente: Cliente | null
  orden: Orden | null
  profile: OrderPrintSettings
  editable?: boolean
  onAddItem?: (item: { descripcion: string; cantidad: number; precio_unitario: number }) => void
  onUpdateItem?: (itemId: string, updates: Partial<ComprobanteItem>) => void
  onDeleteItem?: (itemId: string) => void
}

// ─── Type config ──────────────────────────────────────────────────────────────

const TIPO_CONFIG: Record<TipoComprobante, {
  docLabel: string; letra: string
  color: string; bg: string; border: string; accentBg: string
}> = {
  factura_a:    { docLabel: 'FACTURA', letra: 'A',  color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.40)',  accentBg: 'rgba(59,130,246,0.06)'  },
  factura_c:    { docLabel: 'FACTURA', letra: 'C',  color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.40)', accentBg: 'rgba(139,92,246,0.06)' },
  remito:       { docLabel: 'REMITO',  letra: 'R',  color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.40)', accentBg: 'rgba(16,185,129,0.06)' },
  nota_credito: { docLabel: 'NOTA DE CRÉDITO', letra: 'NC', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.40)', accentBg: 'rgba(245,158,11,0.06)' },
}

const ESTADO_CONFIG: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  borrador: { label: 'Borrador',  dot: 'var(--text-subtle)',  text: 'var(--text-secondary)',  bg: 'var(--bg-surface)'      },
  emitido:  { label: 'Emitido',   dot: 'var(--success)',      text: 'var(--success)',          bg: 'var(--success-subtle)'  },
  anulado:  { label: 'Anulado',   dot: 'var(--error)',        text: 'var(--error)',            bg: 'var(--error-subtle)'    },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v: number, currency: 'ARS' | 'USD' = 'ARS') =>
  new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'es-AR', {
    style: 'currency', currency
  }).format(v)

const fmtFecha = (s: string) =>
  new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })

function padPV(pv: string) { return pv.replace(/\D/g, '').padStart(4, '0') }

function formatNumero(numero: string | null, puntoVenta: string) {
  const pv = padPV(puntoVenta)
  if (!numero) return `${pv}---------`
  return `${pv}-${numero.replace(/\D/g, '').padStart(8, '0')}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Divider() {
  return <div style={{ borderBottom: '1px solid var(--border-color)' }} />
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p style={{
      fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.18em',
      textTransform: 'uppercase', color: 'var(--text-subtle)',
      margin: '0 0 0.625rem',
    }}>
      {children}
    </p>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

function DocHeader({ comprobante, profile }: { comprobante: Comprobante; profile: OrderPrintSettings }) {
  const tipo = TIPO_CONFIG[comprobante.tipo] ?? TIPO_CONFIG.factura_c
  const est  = ESTADO_CONFIG[comprobante.estado] ?? ESTADO_CONFIG.borrador
  const name = profile.nombre_comercial || 'Mi Negocio'
  const addr = profile.domicilio_fiscal
  const wa   = profile.orden_whatsapp
  const ig   = profile.orden_instagram
  const em   = profile.orden_email_visible || profile.email

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto 1fr',
      gap: '1.5rem',
      alignItems: 'center',
      padding: '1.5rem',
      background: `linear-gradient(135deg, var(--bg-tertiary) 0%, ${tipo.accentBg} 100%)`,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Watermark */}
      <div style={{
        position: 'absolute', right: '-0.5rem', top: '50%', transform: 'translateY(-50%)',
        fontSize: '8rem', fontWeight: 900, color: tipo.color,
        opacity: 0.05, pointerEvents: 'none', userSelect: 'none', lineHeight: 1,
      }}>
        {tipo.letra}
      </div>

      {/* Left — Business identity */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
        {/* Logo or placeholder */}
        {profile.comp_mostrar_logo && profile.logo_url ? (
          <img
            src={profile.logo_url}
            alt="Logo"
            style={{
              width: 56, height: 56, objectFit: 'contain',
              borderRadius: 10, flexShrink: 0,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-card)',
              padding: 4,
            }}
          />
        ) : profile.comp_mostrar_logo ? (
          <div style={{
            width: 56, height: 56, borderRadius: 10, flexShrink: 0,
            background: `linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(99,102,241,0.28)',
          }}>
            <span style={{ color: '#fff', fontWeight: 900, fontSize: '1.25rem' }}>
              {name.charAt(0).toUpperCase()}
            </span>
          </div>
        ) : null}

        <div style={{ minWidth: 0 }}>
          <p style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: '1rem', margin: '0 0 0.125rem', lineHeight: 1.2 }}>
            {name}
          </p>
          {profile.razon_social && profile.razon_social !== name && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', margin: '0 0 0.375rem' }}>
              {profile.razon_social}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {profile.comp_mostrar_direccion && addr && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <MapPin size={11} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{addr}</span>
              </div>
            )}
            {profile.comp_mostrar_whatsapp && wa && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Phone size={11} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{wa}</span>
              </div>
            )}
            {profile.comp_mostrar_instagram && ig && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Instagram size={11} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>@{ig.replace(/^@/, '')}</span>
              </div>
            )}
            {profile.comp_mostrar_email && em && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Mail size={11} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{em}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Center — Argentine doc type box */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
        <span style={{
          fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.2em',
          textTransform: 'uppercase', color: 'var(--text-subtle)',
        }}>
          {tipo.docLabel}
        </span>
        <div style={{
          width: 64, height: 64, borderRadius: 12,
          border: `2px solid ${tipo.border}`,
          background: tipo.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 20px ${tipo.bg}`,
        }}>
          <span style={{ fontSize: '2rem', fontWeight: 900, color: tipo.color, lineHeight: 1 }}>
            {tipo.letra}
          </span>
        </div>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-subtle)' }}>Código de tipo</span>
      </div>

      {/* Right — Number, date, status */}
      <div style={{ textAlign: 'right' }}>
        <p style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-subtle)', margin: '0 0 0.25rem' }}>
          Comprobante N°
        </p>
        <p style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1.2rem', color: tipo.color, margin: 0, letterSpacing: '0.04em' }}>
          {formatNumero(comprobante.numero, comprobante.punto_venta)}
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0.25rem 0' }}>
          {fmtFecha(comprobante.fecha)}
        </p>
        {/* Status badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
          padding: '0.2rem 0.625rem', borderRadius: 9999,
          background: est.bg, border: `1px solid ${est.dot}`,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: est.dot, display: 'inline-block' }} />
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: est.text }}>{est.label}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Client & Comprobante info ────────────────────────────────────────────────

function DocInfo({ comprobante, cliente, orden }: {
  comprobante: Comprobante; cliente: Cliente | null; orden: Orden | null
}) {
  const condicion = comprobante.condicion_fiscal || cliente?.condicion_fiscal

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'var(--bg-card)' }}>
      {/* Left — client */}
      <div style={{ padding: '1rem 1.5rem', borderRight: '1px solid var(--border-subtle)' }}>
        <SectionLabel>Cliente</SectionLabel>
        {cliente ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <p style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.9rem', margin: 0 }}>
              {cliente.name}
            </p>
            {cliente.cuit && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontFamily: 'monospace', margin: 0 }}>
                CUIT: {cliente.cuit}
              </p>
            )}
            {condicion && (
              <span style={{
                display: 'inline-block', alignSelf: 'flex-start',
                fontSize: '0.68rem', fontWeight: 600,
                padding: '0.1rem 0.45rem', borderRadius: 4,
                background: 'var(--success-subtle)', color: 'var(--success)',
              }}>
                {condicion}
              </span>
            )}
            {cliente.phone && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0 }}>{cliente.phone}</p>
            )}
            {cliente.address && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0 }}>{cliente.address}</p>
            )}
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.875rem', margin: 0 }}>
            Consumidor Final
          </p>
        )}
      </div>

      {/* Right — document data */}
      <div style={{ padding: '1rem 1.5rem' }}>
        <SectionLabel>Datos del comprobante</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {[
            ['Fecha de emisión', fmtFecha(comprobante.fecha)],
            orden ? ['Orden relacionada', `#${orden.order_number}`] : null,
            comprobante.cae ? ['CAE', comprobante.cae] : null,
            comprobante.cae && comprobante.cae_vencimiento
              ? ['Venc. CAE', fmtFecha(comprobante.cae_vencimiento)]
              : null,
          ].filter(Boolean).map(([label, value]) => (
            <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{label}</span>
              <span style={{
                color: label === 'Orden relacionada' ? 'var(--accent-primary)' : 'var(--text-primary)',
                fontSize: '0.78rem', fontWeight: label === 'CAE' ? 700 : 500,
                fontFamily: label === 'CAE' ? 'monospace' : 'inherit',
              }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Items table ──────────────────────────────────────────────────────────────

const INPUT_S = {
  padding: '0.25rem 0.5rem',
  background: 'var(--input-bg)',
  border: '1px solid var(--accent-primary)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: '0.875rem', outline: 'none', width: '100%',
}

function DocItems({ items, editable, onAddItem, onUpdateItem, onDeleteItem }: {
  items: ComprobanteItem[]
  editable?: boolean
  onAddItem?: (item: { descripcion: string; cantidad: number; precio_unitario: number }) => void
  onUpdateItem?: (itemId: string, updates: Partial<ComprobanteItem>) => void
  onDeleteItem?: (itemId: string) => void
}) {
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<ComprobanteItem>>({})
  const [newItem, setNewItem] = useState({ descripcion: '', cantidad: 1, precio_unitario: 0 })
  const [showAddForm, setShowAddForm] = useState(false)

  const handleEdit = (item: ComprobanteItem) => {
    setEditingItem(item.id)
    setEditForm({ descripcion: item.descripcion, cantidad: item.cantidad, precio_unitario: item.precio_unitario })
  }
  const handleSave = (id: string) => { onUpdateItem?.(id, editForm); setEditingItem(null) }
  const handleAdd = () => {
    if (newItem.descripcion.trim()) {
      onAddItem?.(newItem)
      setNewItem({ descripcion: '', cantidad: 1, precio_unitario: 0 })
      setShowAddForm(false)
    }
  }

  return (
    <div style={{ padding: '1.25rem 1.5rem' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Package size={14} style={{ color: 'var(--accent-primary)' }} />
          <SectionLabel>Detalle de ítems</SectionLabel>
          <span style={{
            fontSize: '0.68rem', fontWeight: 700, padding: '0.1rem 0.45rem',
            borderRadius: 9999, background: 'var(--accent-primary-light)', color: 'var(--accent-primary)',
            marginLeft: '0.25rem', marginBottom: '0.625rem',
          }}>
            {items.length}
          </span>
        </div>
        {editable && !showAddForm && (
          <button onClick={() => setShowAddForm(true)} className="btn btn-primary btn-sm" style={{ marginBottom: '0.625rem' }}>
            <Plus size={13} /> Agregar ítem
          </button>
        )}
      </div>

      {/* Add form */}
      {showAddForm && editable && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 80px 130px auto',
          gap: '0.625rem', alignItems: 'flex-end',
          padding: '0.75rem', marginBottom: '0.75rem',
          background: 'var(--accent-primary-subtle)',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--accent-primary-light)',
        }}>
          <div>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '0.2rem' }}>Descripción</label>
            <input type="text" value={newItem.descripcion} onChange={e => setNewItem({ ...newItem, descripcion: e.target.value })} placeholder="Descripción..." style={INPUT_S} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          </div>
          <div>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '0.2rem' }}>Cant.</label>
            <input type="number" value={newItem.cantidad} onChange={e => setNewItem({ ...newItem, cantidad: Number(e.target.value) })} min="0.01" step="0.01" style={INPUT_S} />
          </div>
          <div>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.7rem', marginBottom: '0.2rem' }}>P. Unit.</label>
            <input type="number" value={newItem.precio_unitario} onChange={e => setNewItem({ ...newItem, precio_unitario: Number(e.target.value) })} min="0" step="0.01" style={INPUT_S} />
          </div>
          <div style={{ display: 'flex', gap: '0.375rem' }}>
            <button onClick={handleAdd} style={{ width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'var(--success-light)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={14} /></button>
            <button onClick={() => setShowAddForm(false)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)', cursor: 'pointer', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface)' }}>
              {['#', 'Descripción', 'Cant.', 'Moneda', 'Precio unit.', 'Subtotal'].map((h, i) => (
                <th key={h} style={{
                  padding: '0.5rem 0.875rem', fontSize: '0.68rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)',
                  textAlign: i === 0 ? 'center' : i <= 1 ? 'left' : 'center',
                  borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
              {editable && <th style={{ padding: '0.5rem', borderBottom: '1px solid var(--border-color)', textAlign: 'center' }} />}
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id}
                style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.8rem' }}>{idx + 1}</td>
                <td style={{ padding: '0.625rem 0.875rem' }}>
                  {editingItem === item.id
                    ? <input type="text" value={editForm.descripcion || ''} onChange={e => setEditForm({ ...editForm, descripcion: e.target.value })} style={INPUT_S} />
                    : <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '0.875rem' }}>{item.descripcion}</span>}
                </td>
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  {editingItem === item.id
                    ? <input type="number" value={editForm.cantidad || 0} onChange={e => setEditForm({ ...editForm, cantidad: Number(e.target.value) })} min="0.01" step="0.01" style={{ ...INPUT_S, width: 70, textAlign: 'right' }} />
                    : <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{item.cantidad}</span>}
                </td>
                {/* Currency badge */}
                <td style={{ padding: '0.625rem 0.5rem', textAlign: 'center' }}>
                  {(() => {
                    const c = item.currency || 'ARS'
                    const isUSD = c === 'USD'
                    return (
                      <span style={{
                        fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em',
                        padding: '0.15rem 0.45rem', borderRadius: 4,
                        background: isUSD ? 'rgba(16,185,129,0.12)' : 'rgba(99,102,241,0.12)',
                        color: isUSD ? 'var(--success)' : 'var(--accent-primary)',
                        border: `1px solid ${isUSD ? 'rgba(16,185,129,0.3)' : 'rgba(99,102,241,0.3)'}`,
                      }}>{c}</span>
                    )
                  })()}
                </td>
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  {editingItem === item.id
                    ? <input type="number" value={editForm.precio_unitario || 0} onChange={e => setEditForm({ ...editForm, precio_unitario: Number(e.target.value) })} min="0" step="0.01" style={{ ...INPUT_S, width: 110, textAlign: 'right' }} />
                    : <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>{fmt(item.precio_unitario, item.currency || 'ARS')}</span>}
                </td>
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.875rem' }}>{fmt(item.subtotal, item.currency || 'ARS')}</span>
                </td>
                {editable && (
                  <td style={{ padding: '0.5rem 0.625rem', textAlign: 'center' }}>
                    {editingItem === item.id ? (
                      <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'center' }}>
                        <button onClick={() => handleSave(item.id)} style={{ width: 26, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--success-light)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={12} /></button>
                        <button onClick={() => setEditingItem(null)} style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border-color)', cursor: 'pointer', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'center' }}>
                        <button onClick={() => handleEdit(item)} style={{ width: 26, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Edit2 size={12} /></button>
                        <button onClick={() => onDeleteItem?.(item.id)} style={{ width: 26, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--error-subtle)', color: 'var(--error)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={12} /></button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={editable ? 7 : 6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.875rem' }}>
                  No hay ítems en este comprobante
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Totals ───────────────────────────────────────────────────────────────────

function DocTotales({ comprobante, items }: { comprobante: Comprobante; items: ComprobanteItem[] }) {
  const tipo      = comprobante.tipo
  const esRemito  = tipo === 'remito'
  const showIva   = tipo === 'factura_a'
  const esNC      = tipo === 'nota_credito'
  const sign      = esNC ? '- ' : ''
  const currency  = comprobante.currency || 'ARS'
  const exchangeRate = comprobante.exchange_rate || 1

  // ── Shared total block style ──────────────────────────────────────────────
  const totalBlockStyle = (isUSD: boolean) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginTop: '0.5rem', padding: '0.75rem 1rem',
    borderRadius: 'var(--radius-md)',
    background: esNC
      ? 'var(--error-subtle)'
      : isUSD ? 'rgba(16,185,129,0.10)' : 'var(--accent-primary-subtle)',
    border: `1px solid ${esNC ? 'var(--error)' : isUSD ? 'rgba(16,185,129,0.35)' : 'var(--accent-primary-light)'}`,
  })

  // ── REMITO: split by item currency ───────────────────────────────────────
  if (esRemito) {
    const itemsARS    = items.filter(i => (i.currency || 'ARS') === 'ARS')
    const itemsUSD    = items.filter(i => i.currency === 'USD')
    const hasARS      = itemsARS.length > 0
    const hasUSD      = itemsUSD.length > 0
    const mixed       = hasARS && hasUSD
    const subtotalARS = itemsARS.reduce((s, i) => s + i.subtotal, 0)
    const subtotalUSD = itemsUSD.reduce((s, i) => s + i.subtotal, 0)

    return (
      <div style={{ padding: '1rem 1.5rem', background: 'var(--bg-card)', display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: mixed ? 340 : 280 }}>
          <SectionLabel>Resumen de importes</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {mixed ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Subtotal <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>(ARS)</span></span>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>{fmt(subtotalARS, 'ARS')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Subtotal <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>(USD)</span></span>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>{fmt(subtotalUSD, 'USD')}</span>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Subtotal</span>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>
                  {hasUSD ? fmt(subtotalUSD, 'USD') : fmt(subtotalARS, 'ARS')}
                </span>
              </div>
            )}

            {hasARS && (
              <div style={totalBlockStyle(false)}>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>Total</p>
                  <p style={{ color: 'var(--text-subtle)', fontSize: '0.65rem', margin: '0.125rem 0 0' }}>Pesos Argentinos (ARS)</p>
                </div>
                <span style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.5rem', color: 'var(--text-primary)' }}>
                  {fmt(subtotalARS, 'ARS')}
                </span>
              </div>
            )}
            {hasUSD && (
              <div style={totalBlockStyle(true)}>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>Total</p>
                  <p style={{ color: 'var(--success)', fontSize: '0.65rem', margin: '0.125rem 0 0' }}>
                    Dólares (USD){exchangeRate > 1 ? ` · T/C $${exchangeRate.toLocaleString('es-AR')}` : ''}
                  </p>
                </div>
                <span style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.5rem', color: 'var(--success)' }}>
                  {fmt(subtotalUSD, 'USD')}
                </span>
              </div>
            )}
            {!hasARS && !hasUSD && (
              <div style={totalBlockStyle(false)}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>Total</p>
                <span style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: '1.5rem', color: 'var(--text-primary)' }}>
                  {fmt(0, 'ARS')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── FACTURAS / NOTA DE CRÉDITO: single currency total ────────────────────
  return (
    <div style={{ padding: '1rem 1.5rem', background: 'var(--bg-card)', display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ width: 280 }}>
        <SectionLabel>Resumen de importes</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Subtotal</span>
            <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>{sign}{fmt(comprobante.subtotal, 'ARS')}</span>
          </div>
          {showIva && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>IVA 21% <span style={{ color: 'var(--text-subtle)', fontSize: '0.75rem' }}>(R.I.)</span></span>
              <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>{sign}{fmt(comprobante.impuestos, 'ARS')}</span>
            </div>
          )}
          {tipo === 'factura_c' && (
            <p style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', fontStyle: 'italic', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)', margin: 0 }}>
              IVA incluido en el precio
            </p>
          )}
          <div style={totalBlockStyle(currency === 'USD')}>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>
                {esNC ? 'Total a devolver' : 'Total a pagar'}
              </p>
              <p style={{ color: 'var(--text-subtle)', fontSize: '0.65rem', margin: '0.125rem 0 0' }}>
                Pesos Argentinos (ARS)
              </p>
            </div>
            <span style={{
              fontFamily: 'monospace', fontWeight: 900, fontSize: '1.5rem',
              color: esNC ? 'var(--error)' : 'var(--text-primary)',
            }}>
              {sign}{fmt(comprobante.total, 'ARS')}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function DocFooter({ comprobante, profile }: { comprobante: Comprobante; profile: OrderPrintSettings }) {
  return (
    <div>
      {/* Thank you + notes */}
      {(profile.comp_mostrar_agradecimiento || profile.comp_mostrar_notas) && (
        <div style={{
          padding: '1rem 1.5rem',
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex', flexDirection: 'column', gap: '0.375rem',
        }}>
          {profile.comp_mostrar_agradecimiento && profile.comp_mensaje_agradecimiento && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 600, margin: 0, textAlign: 'center' }}>
              {profile.comp_mensaje_agradecimiento}
            </p>
          )}
          {profile.comp_mostrar_notas && profile.comp_notas && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0, textAlign: 'center', fontStyle: 'italic' }}>
              {profile.comp_notas}
            </p>
          )}
        </div>
      )}

      {/* System footer */}
      <div style={{
        padding: '0.5rem 1.5rem',
        background: 'var(--bg-tertiary)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: 'var(--text-subtle)', fontSize: '0.65rem', fontFamily: 'monospace' }}>
          ID: {comprobante.id}
        </span>
        <span style={{ color: 'var(--text-subtle)', fontSize: '0.65rem' }}>
          TechRepair{comprobante.cae ? ' · Autorizado AFIP' : ''}
        </span>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ComprobanteDocumento({
  comprobante, items, cliente, orden, profile,
  editable, onAddItem, onUpdateItem, onDeleteItem,
}: ComprobanteDocumentoProps) {
  return (
    <div className="card" style={{ overflow: 'hidden', boxShadow: 'var(--shadow-md)' }}>
      <DocHeader comprobante={comprobante} profile={profile} />
      <Divider />
      <DocInfo comprobante={comprobante} cliente={cliente} orden={orden} />
      <Divider />
      <DocItems items={items} editable={editable} onAddItem={onAddItem} onUpdateItem={onUpdateItem} onDeleteItem={onDeleteItem} />
      <Divider />
      <DocTotales comprobante={comprobante} items={items} />
      <DocFooter comprobante={comprobante} profile={profile} />
    </div>
  )
}
