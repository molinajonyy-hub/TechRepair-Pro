import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle, Loader2, ExternalLink, TrendingUp, Wallet } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useComprobantes } from '../hooks/useComprobantes';
import { useOrderPrintSettings } from '../hooks/useOrderPrintSettings';
import { useAuth } from '../contexts/AuthContext';
import { ComprobanteDocumento } from '../components/comprobantes/ComprobanteDocumento';
import { ComprobanteActions } from '../components/comprobantes/ComprobanteActions';
import { ComprobantePrintLayout } from '../components/comprobantes/ComprobantePrintLayout';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const TIPO_LABELS: Record<string, string> = {
  factura_a: 'Factura A',
  factura_c: 'Factura C',
  remito: 'Remito',
  nota_credito: 'Nota de Crédito',
};

export default function ComprobantePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { businessId } = useAuth();

  const {
    comprobanteActual,
    loading,
    emitiendo,
    error,
    cargarComprobante,
    emitirComprobante,
    anularComprobante,
    agregarItem,
    actualizarItem,
    eliminarItem,
    limpiarError,
  } = useComprobantes(id);

  // Business profile for the template
  const { settings: profile, loading: loadingProfile } = useOrderPrintSettings(businessId);

  const [showSuccess, setShowSuccess] = useState<string | null>(null);

  // Ganancia real del comprobante
  const [profitInfo, setProfitInfo] = useState<{
    totalCost: number
    totalRevenue: number
    profit: number
    margin: number
    inventoryItemsCount: number
    totalItemsCount: number
  } | null>(null);

  useEffect(() => {
    if (id) cargarComprobante(id);
  }, [id, cargarComprobante]);

  // Calcular ganancia real cuando carga el comprobante
  useEffect(() => {
    if (!comprobanteActual) { setProfitInfo(null); return; }
    const items: any[] = (comprobanteActual as any)?.items ?? [];
    if (!items.length) { setProfitInfo(null); return; }

    const totalRevenue = items.reduce((s: number, i: any) => s + (i.subtotal || i.precio_unitario * i.cantidad || 0), 0);
    const inventoryIds = items.filter((i: any) => i.inventory_id).map((i: any) => i.inventory_id);

    if (!inventoryIds.length) {
      // Servicios puros sin costo de inventario
      setProfitInfo({ totalCost: 0, totalRevenue, profit: totalRevenue, margin: 100, inventoryItemsCount: 0, totalItemsCount: items.length });
      return;
    }

    supabase
      .from('inventory')
      .select('id, cost_price')
      .in('id', inventoryIds)
      .then(({ data: invItems }) => {
        const costMap: Record<string, number> = {};
        (invItems || []).forEach((inv: any) => { costMap[inv.id] = inv.cost_price || 0; });

        let totalCost = 0;
        let inventoryItemsCount = 0;
        items.forEach((item: any) => {
          if (item.inventory_id && costMap[item.inventory_id] !== undefined) {
            totalCost += costMap[item.inventory_id] * (item.cantidad || 1);
            inventoryItemsCount++;
          }
        });

        const profit = totalRevenue - totalCost;
        const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;
        setProfitInfo({ totalCost, totalRevenue, profit, margin, inventoryItemsCount, totalItemsCount: items.length });
      })
      .catch(() => setProfitInfo(null));
  }, [comprobanteActual]);

  const handleEmitir = async () => {
    const success = await emitirComprobante();
    if (success) {
      setShowSuccess('Comprobante emitido correctamente en AFIP');
      setTimeout(() => setShowSuccess(null), 5000);
    }
  };

  const handleAnular = async (motivo: string) => {
    const success = await anularComprobante(undefined, motivo);
    if (success) {
      setShowSuccess('Comprobante anulado');
      setTimeout(() => setShowSuccess(null), 5000);
    }
  };

  const handleDescargarPDF = () => {
    if (!comprobanteActual) return;
    const doc = new jsPDF();
    const name = profile.nombre_comercial || 'TechRepair';
    doc.setFont('helvetica');
    doc.setFontSize(18);
    doc.setTextColor(79, 70, 229);
    doc.text(name, 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    if (profile.domicilio_fiscal) doc.text(profile.domicilio_fiscal, 14, 28);
    doc.setFontSize(16);
    doc.setTextColor(0, 0, 0);
    const tipoLabels: Record<string, string> = {
      factura_a: 'FACTURA A', factura_c: 'FACTURA C',
      remito: 'REMITO', nota_credito: 'NOTA DE CRÉDITO',
    };
    doc.text(tipoLabels[comprobanteActual.tipo] || comprobanteActual.tipo, 14, 45);
    doc.setFontSize(12);
    doc.text(`N° ${comprobanteActual.numero || '---'}`, 14, 52);
    doc.setFontSize(10);
    doc.text(`Fecha: ${new Date(comprobanteActual.fecha).toLocaleDateString('es-AR')}`, 14, 58);
    if (comprobanteActual.cae) {
      doc.setTextColor(0, 128, 0);
      doc.text(`CAE: ${comprobanteActual.cae}`, 14, 68);
      if (comprobanteActual.cae_vencimiento) {
        doc.text(`Venc.: ${new Date(comprobanteActual.cae_vencimiento).toLocaleDateString('es-AR')}`, 14, 73);
      }
    }
    const items = (comprobanteActual as any).items || [];
    doc.setTextColor(0, 0, 0);
    autoTable(doc, {
      startY: 82,
      head: [['#', 'Descripción', 'Cant.', 'P.Unit', 'Subtotal']],
      body: items.map((item: any, i: number) => [
        i + 1, item.descripcion, item.cantidad,
        `$${item.precio_unitario.toFixed(2)}`, `$${item.subtotal.toFixed(2)}`,
      ]),
      theme: 'striped',
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
      styles: { fontSize: 9 },
    });
    const finalY = (doc as any).lastAutoTable?.finalY + 10 || 140;
    doc.setFontSize(10);
    doc.text('Subtotal:', 140, finalY);
    doc.text(`$${comprobanteActual.subtotal.toFixed(2)}`, 195, finalY, { align: 'right' });
    if (comprobanteActual.impuestos > 0) {
      doc.text('IVA (21%):', 140, finalY + 6);
      doc.text(`$${comprobanteActual.impuestos.toFixed(2)}`, 195, finalY + 6, { align: 'right' });
    }
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('TOTAL:', 140, finalY + 15);
    doc.text(`$${comprobanteActual.total.toFixed(2)}`, 195, finalY + 15, { align: 'right' });
    if (profile.comp_mensaje_agradecimiento) {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(100, 100, 100);
      doc.text(profile.comp_mensaje_agradecimiento, 14, finalY + 28);
    }
    doc.save(`comprobante-${comprobanteActual.numero || comprobanteActual.id.slice(0, 8)}.pdf`);
  };

  const handleImprimir = () => {
    document.body.classList.add('printing-comprobante');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-comprobante'), 500);
  };
  const puedeEditar = comprobanteActual?.estado === 'borrador';

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading || loadingProfile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4rem', gap: '1rem' }}>
        <Loader2 style={{ width: 36, height: 36, color: 'var(--accent-primary)', animation: 'spin 1s linear infinite' }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Cargando comprobante...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (!comprobanteActual && !loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem 1.5rem' }}>
        <div className="card" style={{ maxWidth: 420, width: '100%', padding: '2.5rem', textAlign: 'center' }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'var(--error-light)', border: '1px solid var(--error)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem',
          }}>
            <AlertCircle style={{ width: 28, height: 28, color: 'var(--error)' }} />
          </div>
          <h2 style={{ color: 'var(--text-primary)', marginBottom: '0.5rem', fontSize: '1.25rem' }}>
            Comprobante no encontrado
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '2rem', fontSize: '0.9rem' }}>
            El comprobante que buscas no existe o fue eliminado.
          </p>
          <button onClick={() => navigate('/orders')} className="btn btn-primary">
            <ArrowLeft size={16} /> Volver a Órdenes
          </button>
        </div>
      </div>
    );
  }

  const orden  = (comprobanteActual as any)?.orden  ?? null;
  const cliente = (comprobanteActual as any)?.cliente ?? null;
  const items  = (comprobanteActual as any)?.items  ?? [];

  // ── Page ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', gap: '1rem' }}>
        <div>
          <nav style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', marginBottom: '0.375rem' }}>
            <Link to="/comprobantes" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Comprobantes</Link>
            <span style={{ color: 'var(--border-strong)' }}>/</span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
              {comprobanteActual && TIPO_LABELS[comprobanteActual.tipo]}
            </span>
          </nav>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, lineHeight: 1.3 }}>
            {comprobanteActual && TIPO_LABELS[comprobanteActual.tipo]}
            {comprobanteActual?.numero && (
              <span style={{ fontFamily: 'monospace', fontWeight: 500, color: 'var(--text-muted)', fontSize: '1rem', marginLeft: '0.5rem' }}>
                #{String(comprobanteActual.numero).padStart(8, '0')}
              </span>
            )}
          </h1>
        </div>
        <Link
          to={comprobanteActual?.order_id ? `/orders/${comprobanteActual.order_id}` : '/comprobantes'}
          className="btn btn-outline"
        >
          <ArrowLeft size={15} /> Volver
        </Link>
      </div>

      {/* Alerts */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.875rem 1rem', borderRadius: 'var(--radius-md)',
          background: 'var(--error-light)', border: '1px solid var(--error)',
          marginBottom: '1rem',
        }}>
          <AlertCircle size={16} style={{ color: 'var(--error)', flexShrink: 0 }} />
          <span style={{ color: 'var(--error)', fontSize: '0.875rem', flex: 1 }}>{error}</span>
          <button onClick={limpiarError} style={{ background: 'none', border: 'none', color: 'var(--error)', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}>
            Cerrar
          </button>
        </div>
      )}
      {showSuccess && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.875rem 1rem', borderRadius: 'var(--radius-md)',
          background: 'var(--success-light)', border: '1px solid var(--success)',
          marginBottom: '1rem',
        }}>
          <CheckCircle size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
          <span style={{ color: 'var(--success)', fontSize: '0.875rem' }}>{showSuccess}</span>
        </div>
      )}

      {/* Print layout — invisible normally, full-page on print */}
      {comprobanteActual && (
        <ComprobantePrintLayout
          comprobante={comprobanteActual}
          items={items}
          cliente={cliente}
          orden={orden}
          profile={profile}
        />
      )}

      {/* Two-column layout */}
      {comprobanteActual && (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>

          {/* Document */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <ComprobanteDocumento
              comprobante={comprobanteActual}
              items={items}
              cliente={cliente}
              orden={orden}
              profile={profile}
              editable={puedeEditar}
              onAddItem={agregarItem}
              onUpdateItem={actualizarItem}
              onDeleteItem={eliminarItem}
            />
          </div>

          {/* Sidebar */}
          <div style={{ width: 272, flexShrink: 0, position: 'sticky', top: '1.5rem' }} className="print:hidden">
            <ComprobanteActions
              comprobante={comprobanteActual}
              onEmitir={handleEmitir}
              onAnular={handleAnular}
              onDescargarPDF={handleDescargarPDF}
              onImprimir={handleImprimir}
              emitiendo={emitiendo}
            />

            {/* Ganancia real del comprobante */}
            {profitInfo !== null && (
              <div style={{
                marginTop: '1rem',
                padding: '1rem',
                backgroundColor: '#0a1628',
                border: `1px solid ${profitInfo.profit >= 0 ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
                borderRadius: '0.75rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.875rem' }}>
                  <TrendingUp size={14} style={{ color: profitInfo.profit >= 0 ? '#34d399' : '#f87171' }} />
                  <p style={{ margin: 0, fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-subtle)' }}>
                    Rentabilidad
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {[
                    { label: 'Total cobrado', value: `$${profitInfo.totalRevenue.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`, color: '#94a3b8' },
                    { label: 'Costo de productos', value: `$${profitInfo.totalCost.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`, color: '#f87171' },
                  ].map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', color: '#475569' }}>{row.label}</span>
                      <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: row.color, fontWeight: 600 }}>{row.value}</span>
                    </div>
                  ))}

                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem', marginTop: '0.125rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#cbd5e1' }}>Ganancia real</span>
                      <span style={{
                        fontSize: '1rem', fontFamily: 'monospace', fontWeight: 800,
                        color: profitInfo.profit >= 0 ? '#34d399' : '#f87171',
                      }}>
                        {profitInfo.profit >= 0 ? '+' : '−'}${Math.abs(profitInfo.profit).toLocaleString('es-AR', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>

                  {/* Margin bar */}
                  <div style={{ marginTop: '0.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.68rem', color: '#334155' }}>Margen</span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: profitInfo.margin >= 30 ? '#34d399' : profitInfo.margin >= 10 ? '#fbbf24' : '#f87171' }}>
                        {profitInfo.margin.toFixed(1)}%
                      </span>
                    </div>
                    <div style={{ height: '5px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '999px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: '999px',
                        width: `${Math.min(Math.max(profitInfo.margin, 0), 100)}%`,
                        background: profitInfo.margin >= 30 ? 'linear-gradient(90deg,#34d399,#10b981)' : profitInfo.margin >= 10 ? '#fbbf24' : '#f87171',
                        transition: 'width 0.4s ease',
                      }} />
                    </div>
                  </div>

                  {profitInfo.inventoryItemsCount < profitInfo.totalItemsCount && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.65rem', color: '#334155', fontStyle: 'italic' }}>
                      {profitInfo.totalItemsCount - profitInfo.inventoryItemsCount} ítem(s) sin costo registrado (servicios)
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Order link */}
            {orden && comprobanteActual.order_id && (
              <div className="card" style={{ marginTop: '1rem', padding: '1rem' }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-subtle)', marginBottom: '0.75rem', marginTop: 0 }}>
                  Orden vinculada
                </p>
                <Link
                  to={`/orders/${comprobanteActual.order_id}`}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '0.75rem', borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
                    textDecoration: 'none', transition: 'all 0.2s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-primary)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-color)'; }}
                >
                  <div>
                    <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.875rem', margin: 0 }}>#{orden.id?.slice(0, 8)}</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: '0.125rem 0 0' }}>Ver orden completa</p>
                  </div>
                  <ExternalLink size={14} style={{ color: 'var(--text-muted)' }} />
                </Link>
              </div>
            )}

            {/* Estado de cobro */}
            {comprobanteActual && !['anulado','cancelled'].includes(comprobanteActual.estado || '') && (
              <div style={{
                marginTop: '1rem', padding: '0.875rem 1rem',
                backgroundColor: (comprobanteActual as any).estado_comercial === 'pagado' ? 'rgba(52,211,153,0.07)' : 'rgba(245,158,11,0.07)',
                border: `1px solid ${(comprobanteActual as any).estado_comercial === 'pagado' ? 'rgba(52,211,153,0.25)' : 'rgba(245,158,11,0.25)'}`,
                borderRadius: '0.75rem',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Wallet size={15} style={{ color: (comprobanteActual as any).estado_comercial === 'pagado' ? '#34d399' : '#f59e0b' }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: (comprobanteActual as any).estado_comercial === 'pagado' ? '#34d399' : '#f59e0b' }}>
                    {(comprobanteActual as any).estado_comercial === 'pagado' ? 'Cobrado' : 'Pendiente de cobro'}
                  </span>
                </div>
                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem', color: (comprobanteActual as any).estado_comercial === 'pagado' ? '#34d399' : '#f59e0b' }}>
                  {(comprobanteActual as any).estado_comercial === 'pagado'
                    ? `$${((comprobanteActual as any).total_cobrado || comprobanteActual.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : `Saldo: $${((comprobanteActual as any).saldo_pendiente || comprobanteActual.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  }
                </span>
              </div>
            )}

            {/* Metadata */}
            <div className="card" style={{ marginTop: '1rem', padding: '1rem' }}>
              <p style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-subtle)', marginBottom: '0.75rem', marginTop: 0 }}>
                Información
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {[
                  ['Tipo', TIPO_LABELS[comprobanteActual.tipo]],
                  ['Fecha', new Date(comprobanteActual.fecha).toLocaleDateString('es-AR')],
                  ['Pto. Venta', String(comprobanteActual.punto_venta).padStart(4, '0')],
                  ...(comprobanteActual.cae_vencimiento
                    ? [['Venc. CAE', new Date(comprobanteActual.cae_vencimiento).toLocaleDateString('es-AR')]]
                    : []),
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{label}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 500 }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
