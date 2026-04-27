import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, FileText, TrendingUp, Receipt, Loader2, AlertTriangle } from 'lucide-react';
import { CloseButton } from '../components/ui/CloseButton';
import { ComprobantesTable } from '../components/comprobantes/ComprobantesTable';
import { ModalCrearComprobante } from '../components/comprobantes/ModalCrearComprobante';
import { Loader } from '../components/ui/Loader';
import { useAuth } from '../contexts/AuthContext';
import comprobanteService, { Comprobante } from '../services/comprobanteService';

export default function ComprobantesPage() {
  const { businessId, user } = useAuth();
  const navigate = useNavigate();

  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const [showModal, setShowModal] = useState(false);

  // ── Cargar comprobantes ──────────────────────────────────────────────────────
  const cargarComprobantes = useCallback(async () => {
    if (!businessId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await comprobanteService.getAll(businessId);
      setComprobantes(data);
    } catch (e: any) {
      setError(e.message || 'Error al cargar comprobantes');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  const limpiarError = () => setError(null);

  const handleEdit = (comp: Comprobante) => navigate(`/comprobantes/${comp.id}`);

  // ── Anular ───────────────────────────────────────────────────────────────────
  const [anulando, setAnulando]         = useState<Comprobante | null>(null);
  const [anulandoMotivo, setAnulandoMotivo] = useState('');
  const [actionLoading, setActionLoading]  = useState<string | null>(null);
  const [actionError, setActionError]      = useState<string | null>(null);

  const confirmarAnular = async () => {
    if (!anulando || !businessId) return;
    setActionLoading(anulando.id);
    setActionError(null);
    try {
      const result = await comprobanteService.anular(
        anulando.id, businessId, user?.id || '', anulandoMotivo || undefined
      );
      if (!result.success) throw new Error(result.error);
      setAnulando(null);
      setAnulandoMotivo('');
      await cargarComprobantes();
    } catch (e: any) {
      setActionError(e.message || 'Error al anular el comprobante');
    } finally {
      setActionLoading(null);
    }
  };

  // ── Eliminar borrador ────────────────────────────────────────────────────────
  const [eliminando, setEliminando]   = useState<Comprobante | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError]     = useState<string | null>(null);

  const confirmarEliminar = async () => {
    if (!eliminando || !businessId) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const result = await comprobanteService.eliminar(eliminando.id, businessId);
      if (!result.success) throw new Error(result.error);
      setEliminando(null);
      await cargarComprobantes();
    } catch (e: any) {
      setDeleteError(e.message || 'Error al eliminar el comprobante');
    } finally {
      setDeleteLoading(false);
    }
  };

  useEffect(() => { cargarComprobantes(); }, [cargarComprobantes]);

  // ── Estadísticas ─────────────────────────────────────────────────────────────
  const isEmitido     = (c: Comprobante) => ['emitido','issued'].includes((c.estado || c.status) ?? '');
  const isBorrador    = (c: Comprobante) => ['borrador','draft'].includes((c.estado || c.status) ?? '');
  const totalEmitido  = comprobantes.filter(isEmitido).length;
  const totalBorrador = comprobantes.filter(isBorrador).length;
  const emitidos      = comprobantes.filter(isEmitido);
  const montoTotalARS = emitidos.reduce((s, c) => s + (c.total_ars || c.total || 0), 0);
  const montoTotalUSD = emitidos.filter(c => c.currency === 'USD').reduce((s, c) => s + (c.total_usd || 0), 0);
  const hayUSD        = montoTotalUSD > 0;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <FileText size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Comprobantes</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona tus facturas, remitos y notas de crédito</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={cargarComprobantes} disabled={loading} className="btn btn-ghost btn-sm">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
          <button onClick={() => setShowModal(true)} disabled={loading} className="btn btn-primary btn-sm">
            <Plus size={16} />
            Nuevo Comprobante
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', 
        gap: '1rem', 
        marginBottom: '2rem' 
      }}>
        {/* Card 1 - Total */}
        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.5rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              borderRadius: '0.5rem'
            }}>
              <Receipt size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Total Comprobantes
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            {comprobantes.length}
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', fontSize: '0.875rem' }}>
            <span style={{ color: '#10b981', fontWeight: 500 }}>{totalEmitido}</span>
            <span style={{ color: '#64748b' }}>emitidos</span>
            <span style={{ color: '#475569' }}>•</span>
            <span style={{ color: '#f59e0b', fontWeight: 500 }}>{totalBorrador}</span>
            <span style={{ color: '#64748b' }}>borradores</span>
          </div>
        </div>

        {/* Card 2 - Monto ARS */}
        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.5rem',
              backgroundColor: '#10b981',
              borderRadius: '0.5rem'
            }}>
              <TrendingUp size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Total Facturado ARS
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            ${montoTotalARS.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#64748b' }}>
            En pesos argentinos
          </div>
        </div>

        {/* Card 3 - Monto USD */}
        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.5rem',
              backgroundColor: '#8b5cf6',
              borderRadius: '0.5rem'
            }}>
              <FileText size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Total Facturado USD
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: hayUSD ? '#34d399' : '#ffffff' }}>
            {hayUSD ? `U$D ${montoTotalUSD.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'U$D 0.00'}
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#64748b' }}>
            En dólares estadounidenses
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div style={{
          marginBottom: '1.5rem',
          padding: '1rem',
          backgroundColor: '#7f1d1d',
          border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: '0.5rem',
          color: '#fca5a5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span style={{ fontWeight: 500 }}>{error}</span>
          <button 
            onClick={limpiarError} 
            style={{
              padding: '0.375rem 0.75rem',
              backgroundColor: 'rgba(239,68,68,0.2)',
              border: 'none',
              color: '#fca5a5',
              borderRadius: '0.375rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500
            }}
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Table */}
      <ComprobantesTable
        comprobantes={comprobantes}
        onEdit={handleEdit}
        onAnular={(comp) => { setActionError(null); setAnulandoMotivo(''); setAnulando(comp) }}
        onEliminar={(comp) => { setDeleteError(null); setEliminando(comp) }}
        actionLoading={actionLoading}
      />

      {/* Loading State */}
      {loading && comprobantes.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '5rem 0' }}>
          <Loader />
        </div>
      )}

      {/* Empty State */}
      {!loading && comprobantes.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: '5rem 0' }}>
          <div style={{
            width: '4rem',
            height: '4rem',
            backgroundColor: '#0f1829',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem'
          }}>
            <FileText size={32} color="#64748b" />
          </div>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
            No hay comprobantes
          </h3>
          <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '1.5rem' }}>
            Comienza creando tu primer comprobante
          </p>
          <button onClick={() => setShowModal(true)} className="btn btn-primary">
            <Plus size={16} />
            Crear Comprobante
          </button>
        </div>
      )}

      {/* Modal Crear Comprobante */}
      <ModalCrearComprobante
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCreado={() => { setShowModal(false); cargarComprobantes(); }}
      />

      {/* Modal Anular Comprobante */}
      {anulando && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', padding: '1.5rem', width: '100%', maxWidth: '440px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={18} style={{ color: '#f59e0b' }} />
                <h3 style={{ margin: 0, color: '#f8fafc', fontWeight: 700 }}>Anular Comprobante</h3>
              </div>
              <CloseButton onClick={() => setAnulando(null)} />
            </div>
            <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>
              Vas a anular el comprobante <strong style={{ color: '#f8fafc' }}>{anulando.numero || `#${anulando.id.slice(0, 8)}`}</strong> por <strong style={{ color: '#f8fafc' }}>${anulando.total.toLocaleString('es-AR')}</strong>.
            </p>
            <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '1rem' }}>
              Esto restaurará el stock de los productos incluidos y revertirá el registro en finanzas.
            </p>
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.4rem' }}>Motivo (opcional)</label>
              <input
                type="text"
                placeholder="Ej: Error en precio, cliente canceló..."
                value={anulandoMotivo}
                onChange={e => setAnulandoMotivo(e.target.value)}
                style={{ width: '100%', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: '0.5rem', color: '#f1f5f9', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            {actionError && <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '1rem' }}>{actionError}</p>}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setAnulando(null)} disabled={!!actionLoading} style={{ padding: '0.5rem 1rem', backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#94a3b8', cursor: 'pointer', fontWeight: 500 }}>Cancelar</button>
              <button onClick={confirmarAnular} disabled={!!actionLoading} style={{ padding: '0.5rem 1rem', backgroundColor: '#d97706', border: 'none', borderRadius: '0.5rem', color: '#fff', cursor: actionLoading ? 'not-allowed' : 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', opacity: actionLoading ? 0.7 : 1 }}>
                {actionLoading ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Anulando...</> : 'Confirmar Anulación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Eliminar Borrador */}
      {eliminando && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', padding: '1.5rem', width: '100%', maxWidth: '420px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, color: '#f8fafc', fontWeight: 700 }}>Eliminar Borrador</h3>
              <CloseButton onClick={() => setEliminando(null)} />
            </div>
            <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>
              ¿Eliminás el borrador <strong style={{ color: '#f8fafc' }}>{eliminando.numero || `#${eliminando.id.slice(0, 8)}`}</strong>? Esta acción no se puede deshacer.
            </p>
            <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '1.25rem' }}>Como es un borrador, no afecta stock ni finanzas.</p>
            {deleteError && <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '1rem' }}>{deleteError}</p>}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setEliminando(null)} disabled={deleteLoading} style={{ padding: '0.5rem 1rem', backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#94a3b8', cursor: 'pointer', fontWeight: 500 }}>Cancelar</button>
              <button onClick={confirmarEliminar} disabled={deleteLoading} style={{ padding: '0.5rem 1rem', backgroundColor: '#dc2626', border: 'none', borderRadius: '0.5rem', color: '#fff', cursor: deleteLoading ? 'not-allowed' : 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', opacity: deleteLoading ? 0.7 : 1 }}>
                {deleteLoading ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Eliminando...</> : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
