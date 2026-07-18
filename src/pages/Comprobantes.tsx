import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { resolvePurchaseKey } from '../utils/purchaseIdempotency';
import { financeErrorMessage } from '../lib/financeErrors';
import { useNavigate, useLocation } from 'react-router-dom';
import { Plus, RefreshCw, FileText, TrendingUp, Receipt, Loader2, AlertTriangle, Search } from 'lucide-react';
import { CloseButton } from '../components/ui/CloseButton';
import { ComprobantesTable } from '../components/comprobantes/ComprobantesTable';
import { ComprobanteProModal as ModalCrearComprobante } from '../components/comprobantes/ComprobanteProModal';
import { Loader } from '../components/ui/Loader';
import { useAuth } from '../contexts/AuthContext';
import comprobanteService, { Comprobante } from '../services/comprobanteService';
import { smartSearch } from '../utils/searchUtils';
import { formatDisplayMessage } from '../utils/formatMessage';

export default function ComprobantesPage() {
  const { businessId, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [comprobantes, setComprobantes] = useState<Comprobante[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [showModal, setShowModal]       = useState(false);
  const [searchTerm, setSearchTerm]     = useState('');

  const cargarComprobantes = useCallback(async () => {
    if (!businessId) return;
    setLoading(true); setError(null);
    try {
      setComprobantes(await comprobanteService.getAll(businessId));
    } catch (e: any) {
      setError(e.message || 'Error al cargar comprobantes');
    } finally { setLoading(false); }
  }, [businessId]);

  const limpiarError = () => setError(null);
  const handleEdit   = (comp: Comprobante) => navigate(`/comprobantes/${comp.id}`);

  // ── Anular (server-side vía annul_comprobante_atomic — no ARCA) ─────────────
  const [anulando, setAnulando]           = useState<Comprobante | null>(null);
  const [anulandoMotivo, setAnulandoMotivo] = useState('');
  const [anulandoReponeStock, setAnulandoReponeStock]       = useState(true);
  const [anulandoDevuelveDinero, setAnulandoDevuelveDinero] = useState(true);
  // M7 7D.3 — Key durable por INTENCIÓN de anulación.
  //
  // Antes se generaba una sola vez al abrir el diálogo. Eso protegía el doble
  // clic, pero el `reason` INTEGRA el request_hash server-side
  // (annul_comprobante_atomic: op, business_id, comprobante_id, mode,
  // restore_stock, reason). Entonces corregir el motivo y reenviar mandaba la
  // MISMA key con otro payload → IDEMPOTENCY_CONFLICT: seguro, pero un callejón
  // sin salida para el usuario, que ya no podía anular sin recargar.
  //
  // Ahora la key rota con el payload. El hash se calcula en el submit, con los
  // valores de ese instante: editar el motivo mientras hay una request en vuelo
  // no puede cambiar el payload ya asociado a la key enviada.
  const anularKeyRef  = useRef<string | null>(null);
  const anularHashRef = useRef<string | null>(null);
  const [actionLoading, setActionLoading]   = useState<string | null>(null);
  const [actionError, setActionError]       = useState<string | null>(null);

  const abrirAnular = (comp: Comprobante) => {
    setActionError(null);
    setAnulandoMotivo('');
    setAnulandoReponeStock(true);
    setAnulandoDevuelveDinero(true);
    // Abrir un diálogo nuevo descarta cualquier intención anterior.
    anularKeyRef.current  = null;
    anularHashRef.current = null;
    setAnulando(comp);
  };

  const confirmarAnular = async () => {
    if (!anulando || !businessId) return;
    if (actionLoading) return;   // M7 7D.3: guard de doble submit
    if (!anulandoMotivo.trim()) { setActionError('Ingresá el motivo de la anulación'); return; }
    setActionLoading(anulando.id); setActionError(null);
    try {
      const devolverDinero = (anulando.total_cobrado ?? 0) > 0 ? anulandoDevuelveDinero : false;
      // Superconjunto del request_hash: motivo + las dos opciones que definen
      // `mode` y `restore_stock`. Cambiar cualquiera es otra intención.
      const intent = [
        'comprobante_annulment', businessId, anulando.id,
        anulandoMotivo.trim(),
        devolverDinero ? 'refund' : 'void',
        anulandoReponeStock ? 'stock:1' : 'stock:0',
      ].join('§');
      const { key } = resolvePurchaseKey(
        anularKeyRef.current, anularHashRef.current, intent, () => crypto.randomUUID(),
      );
      anularKeyRef.current  = key;
      anularHashRef.current = intent;

      const r = await comprobanteService.anular(anulando.id, businessId, user?.id || '', anulandoMotivo, {
        devolverDinero,
        reponerStock:   anulandoReponeStock,
        idempotencyKey: key,
      });
      if (!r.success) throw new Error(financeErrorMessage(r.errorCode, r.error));
      // Éxito terminal: la próxima anulación arranca una intención nueva.
      anularKeyRef.current  = null;
      anularHashRef.current = null;
      setAnulando(null); setAnulandoMotivo('');
      await cargarComprobantes();
    } catch (e: any) { setActionError(e.message || 'Error al anular'); }
    finally { setActionLoading(null); }
  };

  // ── Nota de Crédito (para comprobantes emitidos en ARCA) ────────────────────
  const [ncComprobante, setNcComprobante]   = useState<Comprobante | null>(null);
  const [ncEmitirArca, setNcEmitirArca]     = useState(true);
  const [ncLoading, setNcLoading]           = useState(false);
  const [ncError, setNcError]               = useState<string | null>(null);
  const [ncSuccess, setNcSuccess]           = useState<string | null>(null);

  const confirmarNotaCredito = async () => {
    if (!ncComprobante || !businessId) return;
    setNcLoading(true); setNcError(null);
    try {
      const r = await comprobanteService.crearNotaCredito({
        originalComprobanteId: ncComprobante.id,
        businessId,
        userId:       user?.id || '',
        emitirEnArca: ncEmitirArca,
      });
      if (!r.success) throw new Error(r.error);
      setNcComprobante(null);
      const msg = r.cae
        ? `Nota de Crédito emitida en ARCA. CAE: ${r.cae}`
        : r.arca_error
          ? `NC guardada. Error ARCA: ${r.arca_error}`
          : 'Nota de Crédito generada como borrador.';
      setNcSuccess(msg);
      setTimeout(() => setNcSuccess(null), 6000);
      await cargarComprobantes();
    } catch (e: any) { setNcError(e.message || 'Error al generar Nota de Crédito'); }
    finally { setNcLoading(false); }
  };

  // ── Eliminar comprobante local ───────────────────────────────────────────────
  const [eliminando, setEliminando]       = useState<Comprobante | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError]     = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

  const confirmarEliminar = async () => {
    if (!eliminando || !businessId) return;
    setDeleteLoading(true); setDeleteError(null);
    try {
      const r = await comprobanteService.eliminar(eliminando.id, businessId);
      if (!r.success) {
        if (r.arca_blocked) {
          setDeleteError('Este comprobante ya fue emitido fiscalmente. Para anularlo, generá una Nota de Crédito.');
        } else {
          throw new Error(r.error);
        }
        return;
      }
      setEliminando(null);
      setDeleteSuccess('Comprobante eliminado y caja actualizada.');
      setTimeout(() => setDeleteSuccess(null), 4000);
      await cargarComprobantes();
    } catch (e: any) { setDeleteError(e.message || 'Error al eliminar'); }
    finally { setDeleteLoading(false); }
  };

  useEffect(() => { cargarComprobantes(); }, [cargarComprobantes]);

  // Abrir modal automáticamente cuando se navega desde Inicio con { state: { openNew: true } }
  useEffect(() => {
    if ((location.state as any)?.openNew) {
      setShowModal(true);
      // Limpiar el state para que no re-abra al refrescar
      window.history.replaceState({}, '', location.pathname);
    }
  }, [location.state, location.pathname]);

  // ── Estadísticas ─────────────────────────────────────────────────────────────
  const isEmitido  = (c: Comprobante) => ['emitido','issued'].includes((c.estado || c.status) ?? '');
  const isBorrador = (c: Comprobante) => ['borrador','draft'].includes((c.estado || c.status) ?? '');
  const emitidos      = comprobantes.filter(isEmitido);
  const cobradosPendArca = comprobantes.filter(c => isBorrador(c) && (c.total_cobrado || 0) > 0 && !c.cae && c.estado_fiscal !== 'emitido');
  const montoTotalARS = emitidos.reduce((s, c) => s + (c.total_ars || c.total || 0), 0);
  const montoTotalUSD = emitidos.filter(c => c.currency === 'USD').reduce((s, c) => s + (c.total_usd || 0), 0);

  // ── SmartSearch ───────────────────────────────────────────────────────────────
  const filtered = useMemo(() =>
    smartSearch(comprobantes, searchTerm, [
      { getValue: c => (c as any).numero ?? (c as any).number, weight: 3 },
      { getValue: c => (c.customer as any)?.name,              weight: 2 },
      { getValue: c => c.tipo ?? (c as any).type },
      { getValue: c => c.observaciones },
    ]),
    [comprobantes, searchTerm]
  );

  return (
    <div className="page-shell">
      {/* ── Encabezado ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
            <Receipt size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Comprobantes</h1>
            <p className="page-subtitle">Facturas, remitos y notas de crédito</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={cargarComprobantes} disabled={loading} className="btn btn-ghost btn-sm">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
          </button>
          <button data-testid="comprobantes-new-button" onClick={() => setShowModal(true)} disabled={loading} className="btn btn-primary">
            <Plus size={16} /> Nuevo Comprobante
          </button>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)' }}>
              <Receipt size={18} style={{ color: '#818cf8' }} />
            </div>
            <span className="stat-card-label">Total</span>
          </div>
          <div className="stat-card-value">{comprobantes.length}</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-subtle)', display: 'flex', gap: '0.5rem' }}>
            <span style={{ color: '#10b981', fontWeight: 600 }}>{emitidos.length}</span> emitidos
            &nbsp;·&nbsp;
            <span style={{ color: '#60a5fa', fontWeight: 600 }}>{cobradosPendArca.length}</span> cobr./pend. ARCA
            &nbsp;·&nbsp;
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>{comprobantes.filter(isBorrador).length - cobradosPendArca.length}</span> borradores
          </div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)' }}>
              <TrendingUp size={18} style={{ color: '#34d399' }} />
            </div>
            <span className="stat-card-label">Facturado ARS</span>
          </div>
          <div className="stat-card-value" style={{ color: '#34d399', fontSize: '1.375rem' }}>
            ${montoTotalARS.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-subtle)' }}>Pesos argentinos</div>
        </div>

        {montoTotalUSD > 0 && (
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="stat-icon" style={{ background: 'rgba(139,92,246,0.15)' }}>
                <FileText size={18} style={{ color: '#a78bfa' }} />
              </div>
              <span className="stat-card-label">Facturado USD</span>
            </div>
            <div className="stat-card-value" style={{ color: '#a78bfa', fontSize: '1.375rem' }}>
              U$D {montoTotalUSD.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-subtle)' }}>Dólares</div>
          </div>
        )}
      </div>

      {/* ── Error / Success ── */}
      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{formatDisplayMessage(error)}</span>
          <button className="btn btn-ghost btn-sm" onClick={limpiarError}>Cerrar</button>
        </div>
      )}
      {deleteSuccess && (
        <div className="alert alert-success" style={{ marginBottom: '1.25rem' }}>
          {deleteSuccess}
        </div>
      )}
      {ncSuccess && (
        <div className="alert alert-success" style={{ marginBottom: '1.25rem' }}>
          {ncSuccess}
        </div>
      )}

      {/* ── Buscador ── */}
      <div className="filter-bar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
          <input
            type="text"
            className="form-control"
            placeholder="Buscar por número, cliente, tipo..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '2.5rem' }}
          />
        </div>
        {searchTerm && (
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>
            {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* ── Tabla ── */}
      {loading && comprobantes.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '5rem 0' }}>
          <Loader />
        </div>
      ) : !loading && comprobantes.length === 0 && !error ? (
        <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <FileText size={40} style={{ color: 'var(--text-subtle)', margin: '0 auto 1rem' }} />
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.5rem' }}>Sin comprobantes</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Creá tu primer comprobante</p>
          <button onClick={() => setShowModal(true)} className="btn btn-primary">
            <Plus size={16} /> Crear Comprobante
          </button>
        </div>
      ) : (
        <ComprobantesTable
          comprobantes={filtered}
          onEdit={handleEdit}
          onAnular={abrirAnular}
          onNotaCredito={comp => { setNcError(null); setNcEmitirArca(true); setNcComprobante(comp); }}
          onEliminar={comp => { setDeleteError(null); setEliminando(comp); }}
          actionLoading={ncLoading ? (ncComprobante?.id ?? null) : actionLoading}
        />
      )}

      {/* ── Modal Crear ── */}
      <ModalCrearComprobante
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCreado={() => { setShowModal(false); cargarComprobantes(); }}
      />

      {/* ── Modal Anular ── */}
      {anulando && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setAnulando(null) }}>
          <div className="modal-content" style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                <h3 className="modal-title">Anular Comprobante</h3>
              </div>
              <CloseButton onClick={() => setAnulando(null)} />
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <p style={{ color: 'var(--text-secondary)' }}>
                Vas a anular <strong>{anulando.numero || `#${anulando.id.slice(0,8)}`}</strong> por{' '}
                <strong>${anulando.total.toLocaleString('es-AR')}</strong>. Se revierte exactamente lo
                registrado (cobros, finanzas y cuenta corriente); la caja original no se modifica.
              </p>
              <div>
                <label className="form-label">Motivo *</label>
                <input className="form-control" type="text" placeholder="Ej: Error en precio..." value={anulandoMotivo} onChange={e => setAnulandoMotivo(e.target.value)} />
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', cursor: 'pointer', padding: '0.625rem 0.75rem', background: 'var(--bg-surface)', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}>
                <input
                  type="checkbox"
                  checked={anulandoReponeStock}
                  onChange={e => setAnulandoReponeStock(e.target.checked)}
                  style={{ marginTop: '0.1rem', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                />
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>La mercadería volvió al local</span>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-subtle)' }}>
                    {anulandoReponeStock ? 'Se repone el stock de los productos del comprobante.' : 'El stock NO se modifica (sin devolución física).'}
                  </p>
                </div>
              </label>

              {(anulando.total_cobrado ?? 0) > 0 && (
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', cursor: 'pointer', padding: '0.625rem 0.75rem', background: 'var(--bg-surface)', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}>
                  <input
                    type="checkbox"
                    checked={anulandoDevuelveDinero}
                    onChange={e => setAnulandoDevuelveDinero(e.target.checked)}
                    style={{ marginTop: '0.1rem', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                  />
                  <div>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                      Se devolvió el dinero al cliente (${(anulando.total_cobrado ?? 0).toLocaleString('es-AR')})
                    </span>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-subtle)' }}>
                      El egreso de devolución se registra en la caja abierta actual.
                    </p>
                  </div>
                </label>
              )}

              {actionError && <p style={{ color: 'var(--color-error)', fontSize: '0.85rem' }}>{actionError}</p>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAnulando(null)} disabled={!!actionLoading}>Cancelar</button>
              <button className="btn btn-amber" onClick={confirmarAnular} disabled={!!actionLoading || !anulandoMotivo.trim()}>
                {actionLoading ? <><Loader2 size={14} className="animate-spin" /> Anulando...</> : 'Confirmar Anulación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Eliminar Comprobante ── */}
      {eliminando && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setEliminando(null); setDeleteError(null); } }}>
          <div className="modal-content" style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={16} style={{ color: '#ef4444' }} />
                <h3 className="modal-title">Eliminar Comprobante</h3>
              </div>
              <CloseButton onClick={() => { setEliminando(null); setDeleteError(null); }} />
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ color: 'var(--text-secondary)' }}>
                ¿Eliminás <strong>{eliminando.numero || `#${eliminando.id.slice(0,8)}`}</strong>? Esta acción no se puede deshacer.
              </p>
              <p style={{ color: 'var(--text-subtle)', fontSize: '0.8125rem' }}>
                Se eliminarán también todos los pagos y movimientos de caja asociados a este comprobante.
              </p>
              {deleteError && (
                <div style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: '0.5rem',
                  padding: '0.75rem',
                  color: '#fca5a5',
                  fontSize: '0.85rem',
                }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setEliminando(null); setDeleteError(null); }} disabled={deleteLoading}>Cancelar</button>
              <button className="btn btn-red" onClick={confirmarEliminar} disabled={deleteLoading}>
                {deleteLoading ? <><Loader2 size={14} className="animate-spin" /> Eliminando...</> : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Modal Nota de Crédito ── */}
      {ncComprobante && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !ncLoading) { setNcComprobante(null); setNcError(null); } }}>
          <div className="modal-content" style={{ maxWidth: '460px' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                <h3 className="modal-title">Nota de Crédito</h3>
              </div>
              <CloseButton onClick={() => { if (!ncLoading) { setNcComprobante(null); setNcError(null); } }} />
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <p style={{ color: 'var(--text-secondary)' }}>
                Vas a generar una Nota de Crédito para anular{' '}
                <strong>{ncComprobante.numero_fiscal || ncComprobante.numero || `#${ncComprobante.id.slice(0,8)}`}</strong>{' '}
                por <strong>${(ncComprobante.total ?? 0).toLocaleString('es-AR')}</strong>.
              </p>
              <p style={{ color: 'var(--text-subtle)', fontSize: '0.8125rem' }}>
                El comprobante original quedará marcado como anulado. La caja quedará neteada por el importe de la NC.
              </p>

              {/* Toggle emitir en ARCA */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', cursor: 'pointer', padding: '0.75rem', background: 'var(--bg-surface)', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}>
                <input
                  type="checkbox"
                  checked={ncEmitirArca}
                  onChange={e => setNcEmitirArca(e.target.checked)}
                  style={{ marginTop: '0.1rem', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                />
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>Emitir en ARCA ahora</span>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-subtle)' }}>
                    {ncEmitirArca
                      ? 'Se solicitará CAE a ARCA. Si falla, la NC queda como borrador para reintentar.'
                      : 'Se guardará como borrador. Podés emitirla en ARCA desde el detalle de la NC.'}
                  </p>
                </div>
              </label>

              {ncError && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.5rem', padding: '0.75rem', color: '#fca5a5', fontSize: '0.85rem' }}>
                  {ncError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setNcComprobante(null); setNcError(null); }} disabled={ncLoading}>
                Cancelar
              </button>
              <button className="btn btn-amber" onClick={confirmarNotaCredito} disabled={ncLoading}>
                {ncLoading
                  ? <><Loader2 size={14} className="animate-spin" /> Generando NC...</>
                  : 'Generar Nota de Crédito'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
