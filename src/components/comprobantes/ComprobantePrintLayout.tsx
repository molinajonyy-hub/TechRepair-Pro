/**
 * ComprobantePrintLayout
 * Componente dedicado para impresión. Se renderiza siempre pero está oculto.
 * Cuando se llama window.print() con la clase 'printing-comprobante' en el body,
 * este componente ocupa toda la hoja A4 y todo lo demás queda oculto.
 */

import type { Comprobante, ComprobanteItem } from '../../hooks/useComprobantes'
import type { OrderPrintSettings } from '../../hooks/useOrderPrintSettings'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Cliente {
  id: string; name: string; cuit?: string
  condicion_fiscal?: string; address?: string; email?: string; phone?: string
}

interface Orden { id: string; order_number: string }

interface Props {
  comprobante: Comprobante
  items: ComprobanteItem[]
  cliente: Cliente | null
  orden: Orden | null
  profile: OrderPrintSettings
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v: number, currency: 'ARS' | 'USD' = 'ARS') =>
  new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'es-AR', { style: 'currency', currency }).format(v)

const fmtFecha = (s: string) =>
  new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })

function padPV(pv: string) { return pv.replace(/\D/g, '').padStart(4, '0') }

function formatNumero(numero: string | null, puntoVenta: string) {
  const pv = padPV(puntoVenta)
  if (!numero) return `${pv}---------`
  return `${pv}-${numero.replace(/\D/g, '').padStart(8, '0')}`
}

const TIPO_LABEL: Record<string, string> = {
  factura_a: 'FACTURA A',
  factura_c: 'FACTURA C',
  remito: 'REMITO',
  nota_credito: 'NOTA DE CRÉDITO',
}

const TIPO_LETRA: Record<string, string> = {
  factura_a: 'A', factura_c: 'C', remito: 'R', nota_credito: 'NC',
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ComprobantePrintLayout({ comprobante, items, cliente, orden, profile }: Props) {
  const tipoLetra  = TIPO_LETRA[comprobante.tipo]  ?? '?'
  const nombre     = profile.nombre_comercial || 'Mi Negocio'
  const esRemito   = comprobante.tipo === 'remito'
  const showIva    = comprobante.tipo === 'factura_a'
  const esNC       = comprobante.tipo === 'nota_credito'
  const sign       = esNC ? '- ' : ''
  const wa         = profile.orden_whatsapp
  const ig         = profile.orden_instagram
  const em         = profile.orden_email_visible || profile.email
  const addr       = profile.domicilio_fiscal
  const condicion  = comprobante.condicion_fiscal || cliente?.condicion_fiscal

  return (
    <div className="comprobante-print-layout">
      <style>{`
        .comprobante-print-layout {
          display: none;
          font-family: 'Inter', Arial, Helvetica, sans-serif;
          font-size: 11pt;
          color: #111;
          background: white;
          padding: 12mm 14mm;
          box-sizing: border-box;
          width: 100%;
          min-height: 100vh;
        }

        @media print {
          body.printing-comprobante * { visibility: hidden !important; }
          body.printing-comprobante .comprobante-print-layout,
          body.printing-comprobante .comprobante-print-layout * {
            visibility: visible !important;
          }
          body.printing-comprobante .comprobante-print-layout {
            display: block !important;
            position: fixed !important;
            inset: 0 !important;
            z-index: 99999 !important;
            background: white !important;
            padding: 12mm 14mm !important;
            box-sizing: border-box !important;
          }
          @page {
            size: A4;
            margin: 0;
          }
        }

        /* ── Print typography ── */
        .cpl-h1 { font-size: 20pt; font-weight: 800; margin: 0; color: #111; }
        .cpl-muted { color: #555; font-size: 9pt; }
        .cpl-label { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #777; margin-bottom: 4pt; }
        .cpl-mono  { font-family: 'Courier New', monospace; }

        /* ── Header ── */
        .cpl-header {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 16pt;
          align-items: center;
          padding-bottom: 10pt;
          border-bottom: 2pt solid #111;
          margin-bottom: 10pt;
        }
        .cpl-logo-area { display: flex; align-items: flex-start; gap: 10pt; }
        .cpl-logo-img  { width: 52pt; height: 52pt; object-fit: contain; border: 1pt solid #ddd; border-radius: 4pt; padding: 2pt; }
        .cpl-logo-init {
          width: 52pt; height: 52pt; border-radius: 4pt;
          background: #4f46e5; display: flex; align-items: center; justify-content: center;
          font-size: 22pt; font-weight: 900; color: white; flex-shrink: 0;
        }
        .cpl-biz-name  { font-size: 14pt; font-weight: 800; margin: 0 0 2pt; }
        .cpl-biz-line  { font-size: 8.5pt; color: #444; margin: 1.5pt 0 0; display: flex; align-items: center; gap: 3pt; }

        /* ── Letter box (centro, estilo argentino) ── */
        .cpl-letter-box {
          display: flex; flex-direction: column; align-items: center; gap: 2pt;
        }
        .cpl-doc-title { font-size: 8pt; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #555; }
        .cpl-letter {
          width: 52pt; height: 52pt;
          border: 2pt solid #111; border-radius: 6pt;
          display: flex; align-items: center; justify-content: center;
          font-size: 24pt; font-weight: 900; color: #111;
        }

        /* ── Right of header ── */
        .cpl-doc-meta { text-align: right; }
        .cpl-doc-num  { font-family: 'Courier New', monospace; font-size: 16pt; font-weight: 800; margin: 0 0 3pt; }
        .cpl-doc-date { font-size: 10pt; margin: 2pt 0; color: #333; }
        .cpl-estado   { display: inline-block; padding: 2pt 8pt; border-radius: 20pt; font-size: 8.5pt; font-weight: 700; border: 1pt solid; margin-top: 4pt; }

        /* ── Client / Doc info section ── */
        .cpl-info {
          display: grid; grid-template-columns: 1fr 1fr;
          border: 1pt solid #ccc; border-radius: 4pt;
          margin-bottom: 10pt; overflow: hidden;
        }
        .cpl-info-col { padding: 8pt 10pt; }
        .cpl-info-col + .cpl-info-col { border-left: 1pt solid #ccc; }
        .cpl-client-name { font-size: 12pt; font-weight: 700; margin: 0 0 2pt; }
        .cpl-info-row    { display: flex; justify-content: space-between; margin-bottom: 3pt; font-size: 9.5pt; }
        .cpl-info-val    { font-weight: 600; }

        /* ── Items table ── */
        .cpl-table { width: 100%; border-collapse: collapse; margin-bottom: 10pt; font-size: 9.5pt; }
        .cpl-table th {
          background: #111; color: white; padding: 5pt 8pt;
          text-align: left; font-size: 8pt; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
        }
        .cpl-table th.right, .cpl-table td.right { text-align: right; }
        .cpl-table th.center, .cpl-table td.center { text-align: center; }
        .cpl-table td { padding: 5pt 8pt; border-bottom: 0.5pt solid #e0e0e0; vertical-align: middle; word-break: break-word; overflow-wrap: break-word; }
        .cpl-table tr:last-child td { border-bottom: none; }
        .cpl-table tr:nth-child(even) td { background: #f8f8f8; }
        .cpl-table-outer { border: 1pt solid #ccc; border-radius: 4pt; overflow: hidden; margin-bottom: 10pt; }

        /* ── Totals ── */
        .cpl-totals { display: flex; justify-content: flex-end; margin-bottom: 12pt; }
        .cpl-totals-inner { width: 220pt; }
        .cpl-total-row { display: flex; justify-content: space-between; padding: 3pt 0; font-size: 10pt; border-bottom: 0.5pt solid #e0e0e0; }
        .cpl-total-row:last-child { border-bottom: none; }
        .cpl-total-final {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: 6pt; padding: 8pt 10pt;
          background: #111; color: white; border-radius: 4pt;
        }
        .cpl-total-label { font-size: 10pt; font-weight: 700; }
        .cpl-total-amount { font-size: 16pt; font-weight: 900; font-family: 'Courier New', monospace; }

        /* ── Footer ── */
        .cpl-footer {
          border-top: 1.5pt solid #111; padding-top: 8pt;
          text-align: center;
        }
        .cpl-footer-msg { font-size: 11pt; font-weight: 600; margin-bottom: 4pt; }
        .cpl-footer-id { margin-top: 8pt; font-size: 7.5pt; color: #aaa; font-family: 'Courier New', monospace; }
      `}</style>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div className="cpl-header">

        {/* Left: business identity */}
        <div className="cpl-logo-area">
          {profile.comp_mostrar_logo && profile.logo_url ? (
            <img src={profile.logo_url} alt="Logo" className="cpl-logo-img" />
          ) : profile.comp_mostrar_logo ? (
            <div className="cpl-logo-init">{nombre.charAt(0).toUpperCase()}</div>
          ) : null}
          <div>
            <p className="cpl-biz-name">{nombre}</p>
            {profile.razon_social && profile.razon_social !== nombre && (
              <p className="cpl-muted" style={{ margin: '0 0 4pt' }}>{profile.razon_social}</p>
            )}
            {profile.comp_mostrar_direccion && addr && (
              <p className="cpl-biz-line">📍 {addr}</p>
            )}
            {profile.comp_mostrar_whatsapp && wa && (
              <p className="cpl-biz-line">📱 {wa}</p>
            )}
            {profile.comp_mostrar_instagram && ig && (
              <p className="cpl-biz-line">📸 @{ig.replace(/^@/, '')}</p>
            )}
            {profile.comp_mostrar_email && em && (
              <p className="cpl-biz-line">✉ {em}</p>
            )}
          </div>
        </div>

        {/* Center: Argentine letter box */}
        <div className="cpl-letter-box">
          <p className="cpl-doc-title">{TIPO_LABEL[comprobante.tipo] ?? comprobante.tipo}</p>
          <div className="cpl-letter">{tipoLetra}</div>
        </div>

        {/* Right: number, date, status */}
        <div className="cpl-doc-meta">
          <p className="cpl-label">Comprobante N°</p>
          <p className="cpl-doc-num">{formatNumero(comprobante.numero, comprobante.punto_venta)}</p>
          <p className="cpl-doc-date">{fmtFecha(comprobante.fecha)}</p>
          <p className="cpl-muted">Pto. Venta {padPV(comprobante.punto_venta)}</p>
          {(comprobante.estado === 'emitido' || comprobante.estado === 'anulado') && (
            <span
              className="cpl-estado"
              style={{
                color: comprobante.estado === 'emitido' ? '#059669' : '#dc2626',
                borderColor: comprobante.estado === 'emitido' ? '#059669' : '#dc2626',
                background: comprobante.estado === 'emitido' ? '#ecfdf5' : '#fef2f2',
              }}
            >
              {comprobante.estado === 'emitido' ? '● Emitido' : '✕ Anulado'}
            </span>
          )}
        </div>
      </div>

      {/* ── CLIENT + COMPROBANTE INFO ──────────────────────────────────── */}
      <div className="cpl-info">
        {/* Client */}
        <div className="cpl-info-col">
          <p className="cpl-label">Cliente</p>
          <p className="cpl-client-name">{cliente ? cliente.name : 'Consumidor Final'}</p>
          {cliente?.cuit && <p className="cpl-muted">CUIT: {cliente.cuit}</p>}
          {condicion && <p className="cpl-muted">{condicion}</p>}
          {cliente?.phone && <p className="cpl-muted">{cliente.phone}</p>}
          {cliente?.address && <p className="cpl-muted">{cliente.address}</p>}
        </div>
        {/* Doc info */}
        <div className="cpl-info-col">
          <p className="cpl-label">Datos del comprobante</p>
          <div className="cpl-info-row">
            <span className="cpl-muted">Fecha de emisión</span>
            <span className="cpl-info-val">{fmtFecha(comprobante.fecha)}</span>
          </div>
          {orden && (
            <div className="cpl-info-row">
              <span className="cpl-muted">Orden relacionada</span>
              <span className="cpl-info-val">#{orden.order_number}</span>
            </div>
          )}
          {comprobante.cae && (
            <>
              <div className="cpl-info-row">
                <span className="cpl-muted">CAE</span>
                <span className="cpl-info-val cpl-mono" style={{ fontSize: '8.5pt' }}>{comprobante.cae}</span>
              </div>
              {comprobante.cae_vencimiento && (
                <div className="cpl-info-row">
                  <span className="cpl-muted">Venc. CAE</span>
                  <span className="cpl-info-val">{fmtFecha(comprobante.cae_vencimiento)}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── ITEMS TABLE ───────────────────────────────────────────────── */}
      <div className="cpl-table-outer">
        <table className="cpl-table">
          <thead>
            <tr>
              <th className="center" style={{ width: '28pt' }}>#</th>
              <th>Descripción</th>
              <th className="right" style={{ width: '46pt' }}>Cant.</th>
              <th className="center" style={{ width: '42pt' }}>Moneda</th>
              <th className="right" style={{ width: '90pt' }}>Precio unit.</th>
              <th className="right" style={{ width: '90pt' }}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: '#999', padding: '14pt' }}>Sin ítems</td></tr>
            ) : items.map((item, idx) => {
              const itemCurrency = item.currency || 'ARS'
              const isUSD = itemCurrency === 'USD'
              return (
                <tr key={item.id}>
                  <td className="center" style={{ color: '#777' }}>{idx + 1}</td>
                  <td style={{ fontWeight: 500 }}>{item.descripcion}</td>
                  <td className="right">{item.cantidad}</td>
                  <td className="center">
                    <span style={{
                      fontSize: '7.5pt', fontWeight: 700, padding: '1pt 5pt',
                      borderRadius: '3pt',
                      background: isUSD ? '#d1fae5' : '#e0e7ff',
                      color: isUSD ? '#065f46' : '#3730a3',
                      border: `0.5pt solid ${isUSD ? '#6ee7b7' : '#a5b4fc'}`,
                    }}>{itemCurrency}</span>
                  </td>
                  <td className="right cpl-mono">{fmt(item.precio_unitario, itemCurrency)}</td>
                  <td className="right cpl-mono" style={{ fontWeight: 700 }}>{fmt(item.subtotal, itemCurrency)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── TOTALS ────────────────────────────────────────────────────── */}
      {esRemito ? (() => {
        // REMITO: split totals by item currency
        const itemsARS    = items.filter(i => (i.currency || 'ARS') === 'ARS')
        const itemsUSD    = items.filter(i => i.currency === 'USD')
        const hasARS      = itemsARS.length > 0
        const hasUSD      = itemsUSD.length > 0
        const mixed       = hasARS && hasUSD
        const subtotalARS = itemsARS.reduce((s, i) => s + i.subtotal, 0)
        const subtotalUSD = itemsUSD.reduce((s, i) => s + i.subtotal, 0)
        const exchangeRate = comprobante.exchange_rate || 1

        return (
          <div className="cpl-totals">
            <div className="cpl-totals-inner" style={{ width: mixed ? '280pt' : '220pt' }}>
              {mixed ? (
                <>
                  <div className="cpl-total-row">
                    <span style={{ color: '#555' }}>Subtotal ARS</span>
                    <span className="cpl-mono">{fmt(subtotalARS, 'ARS')}</span>
                  </div>
                  <div className="cpl-total-row">
                    <span style={{ color: '#555' }}>Subtotal USD</span>
                    <span className="cpl-mono">{fmt(subtotalUSD, 'USD')}</span>
                  </div>
                </>
              ) : (
                <div className="cpl-total-row">
                  <span style={{ color: '#555' }}>Subtotal</span>
                  <span className="cpl-mono">{hasUSD ? fmt(subtotalUSD, 'USD') : fmt(subtotalARS, 'ARS')}</span>
                </div>
              )}
              {(hasARS || (!hasARS && !hasUSD)) && (
                <div className="cpl-total-final">
                  <div>
                    <span className="cpl-total-label">Total</span>
                    <div style={{ fontSize: '8pt', color: '#aaa', marginTop: '1pt' }}>Pesos Argentinos (ARS)</div>
                  </div>
                  <span className="cpl-total-amount">{fmt(subtotalARS, 'ARS')}</span>
                </div>
              )}
              {hasUSD && (
                <div className="cpl-total-final" style={{ marginTop: '6pt', background: '#064e3b' }}>
                  <div>
                    <span className="cpl-total-label">Total</span>
                    <div style={{ fontSize: '8pt', color: '#6ee7b7', marginTop: '1pt' }}>
                      Dólares (USD){exchangeRate > 1 ? ` · T/C $${exchangeRate.toLocaleString('es-AR')}` : ''}
                    </div>
                  </div>
                  <span className="cpl-total-amount">{fmt(subtotalUSD, 'USD')}</span>
                </div>
              )}
            </div>
          </div>
        )
      })() : (
        // FACTURA / NOTA DE CRÉDITO: single ARS total
        <div className="cpl-totals">
          <div className="cpl-totals-inner">
            <div className="cpl-total-row">
              <span style={{ color: '#555' }}>Subtotal</span>
              <span className="cpl-mono">{sign}{fmt(comprobante.subtotal, 'ARS')}</span>
            </div>
            {showIva && (
              <div className="cpl-total-row">
                <span style={{ color: '#555' }}>IVA 21% (Resp. Inscripto)</span>
                <span className="cpl-mono">{sign}{fmt(comprobante.impuestos, 'ARS')}</span>
              </div>
            )}
            {comprobante.tipo === 'factura_c' && (
              <div className="cpl-total-row">
                <span style={{ color: '#888', fontStyle: 'italic', fontSize: '8.5pt' }}>IVA incluido en el precio</span>
              </div>
            )}
            <div className="cpl-total-final" style={esNC ? { background: '#7f1d1d' } : {}}>
              <div>
                <span className="cpl-total-label">{esNC ? 'Total a devolver' : 'Total a pagar'}</span>
                <div style={{ fontSize: '8pt', color: '#aaa', marginTop: '1pt' }}>Pesos Argentinos (ARS)</div>
              </div>
              <span className="cpl-total-amount">{sign}{fmt(comprobante.total, 'ARS')}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── FOOTER ────────────────────────────────────────────────────── */}
      <div className="cpl-footer">
        {profile.comp_mostrar_agradecimiento && profile.comp_mensaje_agradecimiento && (
          <p className="cpl-footer-msg">{profile.comp_mensaje_agradecimiento}</p>
        )}
        {profile.comp_mostrar_notas && profile.comp_notas && (
          <p style={{ fontSize: '8.5pt', color: '#666', fontStyle: 'italic', margin: '3pt 0' }}>
            {profile.comp_notas}
          </p>
        )}
        {comprobante.cae && (
          <p className="cpl-footer-id">Comprobante electrónico autorizado por ARCA</p>
        )}
      </div>
    </div>
  )
}
