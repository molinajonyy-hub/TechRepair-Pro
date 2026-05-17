import { useState, useEffect, useMemo } from 'react';
import { Plus, Package, DollarSign, Calendar, Building2, CheckCircle, XCircle, Eye, Search } from 'lucide-react';
import { purchasesService, Purchase } from '../services/purchasesService';
import { useAuth } from '../contexts/AuthContext';
import { smartSearch } from '../utils/searchUtils';
import { Loader } from '../components/ui/Loader';

const STATUS_CLASS: Record<string, string> = {
  pending:   'badge badge-warning',
  confirmed: 'badge badge-success',
  cancelled: 'badge badge-error',
};
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente', confirmed: 'Confirmada', cancelled: 'Cancelada',
};

export function Purchases() {
  const { businessId, user } = useAuth();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading]     = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (businessId) loadData();
    else { setPurchases([]); setLoading(false); }
  }, [businessId]);

  const loadData = async () => {
    if (!businessId) return;
    try {
      setPurchases(await purchasesService.getAllPurchases(businessId));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const filtered = useMemo(() =>
    smartSearch(purchases, searchTerm, [
      { getValue: p => p.invoice_number,               weight: 2 },
      { getValue: p => (p as any).supplier?.name,      weight: 2 },
      { getValue: p => (p as any).notes },
      { getValue: p => String(p.total) },
    ]),
    [purchases, searchTerm]
  );

  const handleConfirm = async (id: string) => {
    if (!businessId) return;
    try { await purchasesService.confirmPurchase(id, businessId, user?.id || ''); await loadData(); }
    catch { alert('Error al confirmar compra'); }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('¿Cancelás esta compra?')) return;
    try { await purchasesService.cancelPurchase(id, businessId || '', user?.id || ''); await loadData(); }
    catch { alert('Error al cancelar compra'); }
  };

  if (loading) {
    return (
      <div className="page-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" />
      </div>
    );
  }

  const pending   = purchases.filter(p => p.status === 'pending').length;
  const confirmed = purchases.filter(p => p.status === 'confirmed').length;
  const totalMonto = purchases.filter(p => p.status !== 'cancelled').reduce((s, p) => s + (p.total || 0), 0);

  return (
    <div className="page-shell">
      {/* ── Encabezado ── */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <Building2 size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Compras a Proveedores</h1>
            <p className="page-hdr-subtitle">Gestioná tus órdenes de compra</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button className="btn btn-primary btn-lift">
            <Plus size={16} /> Nueva Compra
          </button>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)' }}>
              <Package size={16} style={{ color: '#818cf8' }} />
            </div>
            <span className="stat-card-label">Total</span>
          </div>
          <div className="stat-card-value">{purchases.length}</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(245,158,11,0.15)' }}>
              <Calendar size={16} style={{ color: '#f59e0b' }} />
            </div>
            <span className="stat-card-label">Pendientes</span>
          </div>
          <div className="stat-card-value" style={{ color: '#f59e0b' }}>{pending}</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)' }}>
              <CheckCircle size={16} style={{ color: '#34d399' }} />
            </div>
            <span className="stat-card-label">Confirmadas</span>
          </div>
          <div className="stat-card-value" style={{ color: '#34d399' }}>{confirmed}</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(52,211,153,0.12)' }}>
              <DollarSign size={16} style={{ color: '#34d399' }} />
            </div>
            <span className="stat-card-label">Monto total</span>
          </div>
          <div className="stat-card-value" style={{ fontSize: '1.25rem', color: '#34d399' }}>
            ${totalMonto.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </div>
        </div>
      </div>

      {/* ── Buscador ── */}
      <div className="filter-bar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
          <input
            type="text"
            className="form-control"
            placeholder="Buscar por proveedor, factura, notas..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '2.5rem' }}
          />
        </div>
      </div>

      {/* ── Tabla ── */}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Factura</th>
              <th>Total</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-subtle)' }}>
                  {searchTerm ? `Sin resultados para "${searchTerm}"` : 'No hay compras registradas'}
                </td>
              </tr>
            )}
            {filtered.map(p => (
              <tr key={p.id}>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}>
                    <Calendar size={13} style={{ color: 'var(--text-subtle)' }} />
                    {new Date(p.purchase_date).toLocaleDateString('es-AR')}
                  </span>
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>
                  {(p as any).supplier?.name || '—'}
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}>
                  {p.invoice_number || '—'}
                </td>
                <td>
                  <span style={{ fontWeight: 700, color: '#34d399', fontFamily: 'monospace' }}>
                    ${p.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                  </span>
                </td>
                <td>
                  <span className={STATUS_CLASS[p.status] || 'badge'}>
                    {STATUS_LABEL[p.status] || p.status}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm"><Eye size={14} /></button>
                    {p.status === 'pending' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => handleConfirm(p.id)}>
                        <CheckCircle size={14} style={{ color: '#34d399' }} />
                      </button>
                    )}
                    {p.status !== 'cancelled' && (
                      <button className="btn btn-ghost btn-sm" onClick={() => handleCancel(p.id)}>
                        <XCircle size={14} style={{ color: 'var(--color-error)' }} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
