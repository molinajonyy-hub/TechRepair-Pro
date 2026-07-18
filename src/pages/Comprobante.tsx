import { useCallback, useEffect, useRef, useState } from 'react';
import { resolvePurchaseKey } from '../utils/purchaseIdempotency';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle, Loader2, ExternalLink, TrendingUp, Wallet, Edit2, X, FileText } from 'lucide-react';
import { WhatsAppActionButton } from '../components/whatsapp/WhatsAppActionButton';
import { supabase } from '../lib/supabase';
import { facturacionService } from '../services/facturacionService';
import { useOrderPrintSettings } from '../hooks/useOrderPrintSettings';
import { useAuth } from '../contexts/AuthContext';
import { ComprobanteDocumento } from '../components/comprobantes/ComprobanteDocumento';
import { formatDisplayMessage } from '../utils/formatMessage';
import { ComprobanteActions } from '../components/comprobantes/ComprobanteActions';
import { ComprobantePrintLayout } from '../components/comprobantes/ComprobantePrintLayout';
import {
  comprobanteService, MedioPago, type Comprobante,
  isArcaConnectionError, ARCA_CONNECTION_ERROR_TITLE, ARCA_CONNECTION_ERROR_MESSAGE,
  ARCA_PENDING_RECONCILIATION_TITLE, ARCA_PENDING_RECONCILIATION_MESSAGE,
  splitArcaRejectionMessage,
} from '../services/comprobanteService';
import { buildComprobanteFilename } from '../lib/printFilename';
import { logger } from '../lib/logger';

const TIPO_LABELS: Record<string, string> = {
  factura_a: 'Factura A',
  factura_c: 'Factura C',
  remito: 'Remito',
  nota_credito: 'Nota de Crédito',
};

export default function ComprobantePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { businessId, user } = useAuth();

  // Carga y mutaciones vía comprobanteService — la misma fuente única que usa el
  // POS (ComprobanteProModal). Antes esta página usaba el hook legacy useComprobantes
  // (facturacionService/afipService), que emitía un CAE simulado sin llamar a ARCA.
  const [comprobanteActual, setComprobanteActual] = useState<Comprobante | null>(null);
  const [loading, setLoading] = useState(true);
  const [emitiendo, setEmitiendo] = useState(false);
  // M7 7D: key durable por INTENCIÓN de anulación (no por clic). Ver handleAnular.
  const anularKeyRef  = useRef<string | null>(null);
  const anularHashRef = useRef<string | null>(null);
  // M7 7D.1: ídem para el reemplazo de cobro. Ver handleSaveEditPago.
  const replaceKeyRef  = useRef<string | null>(null);
  const replaceHashRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargarComprobante = useCallback(async (compId: string) => {
    if (!businessId) return;
    setLoading(true);
    setError(null);
    try {
      const comp = await comprobanteService.getById(compId, businessId);
      setComprobanteActual(comp);
      if (!comp) setError('Comprobante no encontrado');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al cargar el comprobante');
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  const limpiarError = useCallback(() => setError(null), []);

  // Item CRUD: comprobanteService todavía no expone estas operaciones (solo aplica a
  // borradores no fiscales), así que se mantienen sobre facturacionService, que opera
  // sobre la misma tabla comprobante_items. No afecta CAE, numeración ni stock.
  const agregarItem = useCallback(async (item: { descripcion: string; cantidad: number; precio_unitario: number; inventory_id?: string }) => {
    if (!comprobanteActual || !businessId) return false;
    const result = await facturacionService.agregarItem(comprobanteActual.id, item, businessId, user?.id);
    if (result.success) { await cargarComprobante(comprobanteActual.id); return true; }
    setError(result.error || 'Error al agregar item');
    return false;
  }, [comprobanteActual, businessId, user?.id, cargarComprobante]);

  const actualizarItem = useCallback(async (itemId: string, updates: Record<string, unknown>) => {
    const result = await facturacionService.actualizarItem(itemId, updates);
    if (result.success) { if (comprobanteActual) await cargarComprobante(comprobanteActual.id); return true; }
    setError(result.error || 'Error al actualizar item');
    return false;
  }, [comprobanteActual, cargarComprobante]);

  const eliminarItem = useCallback(async (itemId: string) => {
    const result = await facturacionService.eliminarItem(itemId);
    if (result.success) { if (comprobanteActual) await cargarComprobante(comprobanteActual.id); return true; }
    setError(result.error || 'Error al eliminar item');
    return false;
  }, [comprobanteActual, cargarComprobante]);

  // Business profile for the template
  const { settings: profile, loading: loadingProfile } = useOrderPrintSettings(businessId);

  const [showSuccess, setShowSuccess] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  // ── Editar cobro ──────────────────────────────────────────────────────────
  const [showEditPago, setShowEditPago] = useState(false);
  const [editPagoLoading, setEditPagoLoading] = useState(false);
  const [editPagoMethod, setEditPagoMethod] = useState<MedioPago>('efectivo');
  const [editPagoAmount, setEditPagoAmount] = useState(0);
  const [editPagoNotes, setEditPagoNotes] = useState('');

  // ── Crear nota de crédito ─────────────────────────────────────────────────
  const [showNotaCredito, setShowNotaCredito] = useState(false);
  const [notaCreditoMotivo, setNotaCreditoMotivo] = useState('');
  const [notaCreditoLoading, setNotaCreditoLoading] = useState(false);

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
      },
      () => setProfitInfo(null)
      );
  }, [comprobanteActual]);

  const handleEmitir = async () => {
    if (!comprobanteActual || !businessId || !user) return;
    setEmitiendo(true);
    setError(null);
    try {
      const result = await comprobanteService.emitir(comprobanteActual.id, businessId, user.id, true);
      if (result.success) {
        setShowSuccess('Comprobante emitido correctamente en ARCA');
        setTimeout(() => setShowSuccess(null), 5000);
        await cargarComprobante(comprobanteActual.id);
      } else if (result.pendingReconciliation) {
        logger.error('FINANCE', 'Emisión ARCA ambigua — pendiente de conciliación', result.error);
        setError(`${ARCA_PENDING_RECONCILIATION_TITLE}. ${ARCA_PENDING_RECONCILIATION_MESSAGE}`);
        await cargarComprobante(comprobanteActual.id); // refleja estado_fiscal='pendiente_conciliacion'
      } else if (result.alreadyInProgress) {
        // Claim atómico (DB) detectó un intento vivo — o de este MISMO
        // comprobante (otra pestaña/usuario ya lo está emitiendo) o de OTRO
        // comprobante de la MISMA serie fiscal (result.serieOcupada). Nunca se
        // dispara una segunda emisión: solo se informa y se recarga el estado.
        setError(result.error || 'La emisión ya está siendo procesada. Esperá unos segundos y volvé a revisar el comprobante.');
        await cargarComprobante(comprobanteActual.id);
      } else if (isArcaConnectionError(result.error)) {
        logger.error('FINANCE', 'Reintento de emisión ARCA falló (conectividad)', result.error);
        setError(`${ARCA_CONNECTION_ERROR_TITLE}. ${ARCA_CONNECTION_ERROR_MESSAGE}`);
      } else {
        setError(result.error || 'Error al emitir en ARCA');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al emitir en ARCA');
    } finally {
      setEmitiendo(false);
    }
  };

  const handleAnular = async (motivo: string) => {
    if (!comprobanteActual || !businessId || !user) return;
    try {
      // M7 7D: una key por INTENCIÓN de anulación, no por clic. Si la respuesta
      // se pierde (timeout) y el usuario reintenta la MISMA anulación, la key
      // hace que el server devuelva replay en vez de rechazar con
      // ALREADY_ANNULLED. Rota sola si cambia el comprobante o el motivo.
      const intent = `annul§${businessId}§${comprobanteActual.id}§${motivo.trim()}`;
      const { key } = resolvePurchaseKey(
        anularKeyRef.current, anularHashRef.current, intent, () => crypto.randomUUID(),
      );
      anularKeyRef.current = key;
      anularHashRef.current = intent;

      const result = await comprobanteService.anular(
        comprobanteActual.id, businessId, user.id, motivo, { idempotencyKey: key },
      );
      if (result.success) {
        anularKeyRef.current = null;   // éxito terminal: se descarta la key
        anularHashRef.current = null;
        setShowSuccess('Comprobante anulado');
        setTimeout(() => setShowSuccess(null), 5000);
        await cargarComprobante(comprobanteActual.id);
      } else if (result.requiereNotaCredito) {
        // Red de seguridad: la UI ya oculta "Anular" para comprobantes con CAE
        // (ver ComprobanteActions), pero si de todos modos se llega acá,
        // dirigimos directo al flujo fiscal correcto en vez de solo mostrar error.
        setError(result.error || 'Este comprobante requiere una Nota de Crédito para anularse.');
        setShowNotaCredito(true);
      } else {
        setError(result.error || 'Error al anular el comprobante');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al anular el comprobante');
    }
  };

  const handleDescargarPDF = async () => {
    if (!comprobanteActual || pdfLoading) return;
    setPdfLoading(true);
    try {
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
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
      const bizName = profile.nombre_comercial || profile.razon_social || null;
      doc.save(buildComprobanteFilename(bizName, comprobanteActual.tipo, comprobanteActual.numero, comprobanteActual.id));
    } catch (err) {
      console.error('Error generando PDF:', err);
    } finally {
      setPdfLoading(false);
    }
  };

  const handleImprimir = () => {
    if (!comprobanteActual) return;
    // El browser usa document.title como nombre sugerido al "Guardar como PDF".
    // Lo actualizamos temporalmente para que coincida con el filename correcto.
    const bizName = profile.nombre_comercial || profile.razon_social || null;
    const filename = buildComprobanteFilename(bizName, comprobanteActual.tipo, comprobanteActual.numero, comprobanteActual.id);
    const prevTitle = document.title;
    document.title = filename.replace(/\.pdf$/i, '');
    document.body.classList.add('printing-comprobante');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-comprobante');
      document.title = prevTitle;
    }, 1000);
  };

  const openEditPago = () => {
    if (!comprobanteActual) return;
    const pagos = (comprobanteActual as any).pagos as any[] | undefined;
    const primero = pagos?.[0];
    setEditPagoMethod((primero?.payment_method as MedioPago) || 'efectivo');
    setEditPagoAmount(comprobanteActual.total || 0);
    setEditPagoNotes(primero?.notes || '');
    // M7 7D.1: abrir una edición NUEVA descarta cualquier key anterior. Sin
    // esto, reabrir el modal tras un resultado terminal podría reusar la key de
    // la intención pasada.
    replaceKeyRef.current = null;
    replaceHashRef.current = null;
    setShowEditPago(true);
  };

  const closeEditPago = () => {
    // Cancelación deliberada: la intención se abandona, la key se descarta.
    replaceKeyRef.current = null;
    replaceHashRef.current = null;
    setShowEditPago(false);
  };

  const handleSaveEditPago = async () => {
    if (!comprobanteActual || !businessId || !user) return;
    setEditPagoLoading(true);
    try {
      // M7 7D.1 — BOUNDARY DE LA INTENCIÓN: "reemplazar el cobro de ESTE
      // comprobante por ESTE". El hash lleva TODOS los campos económicos que
      // viajan a la RPC, no sólo los que el modal edita hoy: si mañana el
      // formulario expone provider o comisión, la rotación ya funciona.
      const currency = 'ARS' as const;
      const rate = 1;
      const amountArs = editPagoAmount;   // ARS: amount_ars == amount
      const intent = [
        'replace_payment',
        comprobanteActual.id,           // rota al cambiar de comprobante
        editPagoMethod,
        editPagoAmount.toFixed(2),
        amountArs.toFixed(2),
        currency,
        rate.toFixed(6),
        '∅',                            // provider (el modal no lo expone aún)
        (0).toFixed(2),                 // comisión (idem)
        (editPagoNotes || '').trim(),
      ].join('§');

      const { key } = resolvePurchaseKey(
        replaceKeyRef.current, replaceHashRef.current, intent, () => crypto.randomUUID(),
      );
      replaceKeyRef.current = key;
      replaceHashRef.current = intent;

      const result = await comprobanteService.actualizarPago(
        comprobanteActual.id, businessId, user.id,
        { payment_method: editPagoMethod, amount: editPagoAmount, currency, notes: editPagoNotes,
          idempotencyKey: key }
      );

      if (result.success) {
        // Éxito confirmado: la intención terminó, la key se descarta.
        replaceKeyRef.current = null;
        replaceHashRef.current = null;
        setShowSuccess('Cobro actualizado correctamente');
        setTimeout(() => setShowSuccess(null), 4000);
        setShowEditPago(false);
        if (id) cargarComprobante(id);
        return;
      }

      if (result.errorCode === 'PAYMENT_SET_CHANGED') {
        // El conjunto de cobros cambió mientras se procesaba. La key quedó
        // STALE server-side: reintentarla devolvería PAYMENT_SET_CHANGED para
        // siempre. Se descarta, se refresca el comprobante y se exige una
        // intención nueva. NO se reenvía automáticamente.
        replaceKeyRef.current = null;
        replaceHashRef.current = null;
        if (id) await cargarComprobante(id);
        window.alert(result.error || 'El cobro cambió mientras se procesaba. Actualizá el comprobante e intentá nuevamente.');
        return;
      }

      if (result.conflict) {
        // Misma key con otro payload. NO se genera otra key ni se reintenta
        // solo: lo revisa el usuario.
        if (id) await cargarComprobante(id);
        window.alert(result.error || 'La solicitud ya fue utilizada con datos diferentes.');
        return;
      }

      // Validación u otro error definitivo: la key se CONSERVA. Si el usuario
      // corrige el payload, el hash cambia y rota sola; si reintenta igual, es
      // el mismo intento.
      window.alert(result.error || 'Error al actualizar el cobro');
    } finally {
      setEditPagoLoading(false);
    }
  };

  const handleCrearNotaCredito = async () => {
    if (!comprobanteActual || !businessId || !user) return;
    setNotaCreditoLoading(true);
    try {
      const result = await comprobanteService.crearNotaCredito({
        originalComprobanteId: comprobanteActual.id,
        businessId,
        userId: user.id,
        motivo: notaCreditoMotivo,
      });
      if (result.success && result.nc) {
        setShowNotaCredito(false);
        setNotaCreditoMotivo('');
        navigate(`/comprobantes/${result.nc.id}`);
      } else {
        window.alert(result.error || result.arca_error || 'Error al crear la nota de crédito');
      }
    } finally {
      setNotaCreditoLoading(false);
    }
  };
  const puedeEditar = comprobanteActual?.estado === 'borrador';

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading || loadingProfile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4rem', gap: '1rem' }}>
        <Loader2 style={{ width: 36, height: 36, color: 'var(--accent-primary)', animation: 'tr-spin 1s linear infinite' }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Cargando comprobante...</p>
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

  // comprobanteService.getById() trae la relación como `customer` (no `cliente`) y no
  // incluye la orden completa — solo necesitamos el id para el link "Orden vinculada".
  const orden: any = comprobanteActual?.order_id ? { id: comprobanteActual.order_id } : null;
  const cliente = (comprobanteActual as any)?.customer ?? null;
  const items  = (comprobanteActual as any)?.items  ?? [];

  // ── Page ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Title row */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div>
            <nav style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', marginBottom: '0.375rem' }}>
              <Link to="/comprobantes" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Comprobantes</Link>
              <span style={{ color: 'var(--border-strong)' }}>/</span>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                {comprobanteActual && TIPO_LABELS[comprobanteActual.tipo]}
              </span>
            </nav>
            <h1 className="page-hdr-title">
              {comprobanteActual && TIPO_LABELS[comprobanteActual.tipo]}
              {comprobanteActual?.numero && (
                <span style={{ fontFamily: 'monospace', fontWeight: 500, color: 'var(--text-muted)', fontSize: '1rem', marginLeft: '0.5rem' }}>
                  #{String(comprobanteActual.numero).padStart(8, '0')}
                </span>
              )}
            </h1>
          </div>
        </div>
        <div className="page-hdr-right" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* WhatsApp: enviar comprobante o recordatorio de saldo */}
          {comprobanteActual && (
            <WhatsAppActionButton
              data-testid={(comprobanteActual as any).saldo_pendiente > 0 ? 'comprobante-whatsapp-debt' : 'comprobante-whatsapp-send'}
              recipientName={cliente?.name ?? ''}
              phone={cliente?.phone ?? (orden?.customer as any)?.phone ?? null}
              templateKey={(comprobanteActual as any).saldo_pendiente > 0 ? 'debt_reminder' : 'comprobante_issued'}
              vars={{
                nombre:             (cliente?.name ?? '').split(' ')[0] || (cliente?.name ?? ''),
                cliente:            cliente?.name ?? '',
                tipo_comprobante:   TIPO_LABELS[comprobanteActual.tipo] ?? comprobanteActual.tipo,
                numero_comprobante: (comprobanteActual as any).numero_fiscal ?? comprobanteActual.numero ?? '',
                precio:             comprobanteActual.total ? `$${Math.round(comprobanteActual.total).toLocaleString('es-AR')}` : '',
                saldo:              (comprobanteActual as any).saldo_pendiente > 0 ? `$${Math.round((comprobanteActual as any).saldo_pendiente).toLocaleString('es-AR')}` : '',
              }}
              context={{
                comprobantId: comprobanteActual.id,
                customerId: cliente?.id ?? comprobanteActual.customer_id ?? undefined,
                orderId: comprobanteActual.order_id ?? undefined,
              }}
              disabledReason={
                !cliente?.phone && !((orden?.customer as any)?.phone)
                  ? 'El cliente no tiene teléfono registrado'
                  // Nunca compartir un comprobante fiscal como "emitido" sin CAE real
                  // (remitos no son fiscales y siempre pueden compartirse).
                  : (comprobanteActual.tipo !== 'remito' && !comprobanteActual.cae)
                    ? 'El comprobante todavía no fue autorizado por ARCA'
                    : undefined
              }
            />
          )}
          <Link
            to={comprobanteActual?.order_id ? `/orders/${comprobanteActual.order_id}` : '/comprobantes'}
            className="btn btn-outline"
          >
            <ArrowLeft size={15} /> Volver
          </Link>
        </div>
      </div>

      {/* Alerts */}
      {error && (() => {
        // Rechazo ARCA: mostrar prominente solo el motivo accionable; los
        // avisos informativos que AFIP concatena ("IMPORTANTE: ...") quedan
        // en un detalle expandible — visibles, pero sin tapar el error real.
        const { principal, detalle } = splitArcaRejectionMessage(formatDisplayMessage(error));
        return (
          <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>
              {principal}
              {detalle && (
                <details style={{ marginTop: '0.375rem' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '0.78rem', opacity: 0.8 }}>Ver aviso completo de ARCA</summary>
                  <span style={{ fontSize: '0.78rem', opacity: 0.85 }}>{detalle}</span>
                </details>
              )}
            </span>
            <button onClick={limpiarError} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}>
              Cerrar
            </button>
          </div>
        );
      })()}
      {showSuccess && (
        <div className="alert-inline alert-success" style={{ marginBottom: '1rem' }}>
          <CheckCircle size={16} style={{ flexShrink: 0 }} />
          <span>{showSuccess}</span>
        </div>
      )}

      {/* Print layout — invisible normally, full-page on print */}
      {comprobanteActual && (
        <ComprobantePrintLayout
          comprobante={comprobanteActual as any}
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
              comprobante={comprobanteActual as any}
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
              comprobante={comprobanteActual as any}
              onEmitir={handleEmitir}
              onAnular={handleAnular}
              onDescargarPDF={handleDescargarPDF}
              onImprimir={handleImprimir}
              onCrearNotaCredito={() => setShowNotaCredito(true)}
              emitiendo={emitiendo}
              pdfLoading={pdfLoading}
            />

            {/* Ganancia real del comprobante */}
            {profitInfo !== null && (
              <div className="surface-raised" style={{
                marginTop: '1rem',
                padding: '1rem',
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
              <EstadoCobroWidget
                comprobante={comprobanteActual}
                onEditarCobro={openEditPago}
              />
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

      {/* ── Modal: Editar cobro ──────────────────────────────────────────────── */}
      {showEditPago && comprobanteActual && (
        <div className="modal-overlay-dark">
          <div className="modal-card" style={{ maxWidth: 440 }}>
            <div className="modal-hdr">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <Wallet size={18} style={{ color: 'var(--accent-primary)' }} />
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Editar cobro
                </h2>
              </div>
              <button onClick={closeEditPago} className="icon-btn" aria-label="Cerrar">
                <X size={16} />
              </button>
            </div>

            <div className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label className="label-caps">Medio de pago</label>
                <select
                  data-testid="edit-payment-method-select"
                  value={editPagoMethod}
                  onChange={e => setEditPagoMethod(e.target.value as MedioPago)}
                  className="form-select"
                >
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="tarjeta_debito">Tarjeta débito</option>
                  <option value="tarjeta_credito">Tarjeta crédito</option>
                  <option value="qr">QR / Mercado Pago</option>
                  <option value="mixto">Mixto</option>
                  <option value="cuenta_corriente">Cuenta corriente</option>
                  <option value="otro">Otro</option>
                </select>
              </div>

              <div>
                <label className="label-caps">Monto cobrado (ARS)</label>
                <input
                  data-testid="edit-payment-amount-input"
                  type="number"
                  min={0}
                  step={0.01}
                  value={editPagoAmount}
                  onChange={e => setEditPagoAmount(parseFloat(e.target.value) || 0)}
                  className="form-control"
                  style={{ fontFamily: 'monospace', fontSize: '1rem', fontWeight: 700 }}
                />
                <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>
                  Total del comprobante: ${(comprobanteActual.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>

              <div>
                <label className="label-caps">Observación interna</label>
                <input
                  type="text"
                  value={editPagoNotes}
                  onChange={e => setEditPagoNotes(e.target.value)}
                  placeholder="Ej: Pagó en dos cuotas, transferencia 18/5..."
                  className="form-control"
                />
              </div>

              {editPagoMethod === 'cuenta_corriente' && (
                <div className="alert-inline alert-warning">
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>Al elegir cuenta corriente, el saldo quedará pendiente y se registrará en la CC del cliente.</span>
                </div>
              )}
            </div>

            <div className="modal-ftr" style={{ justifyContent: 'flex-end' }}>
              <button onClick={closeEditPago} className="btn btn-ghost" disabled={editPagoLoading}>
                Cancelar
              </button>
              <button
                data-testid="edit-payment-save-button"
                onClick={() => void handleSaveEditPago()}
                disabled={editPagoLoading || editPagoAmount < 0}
                className="btn btn-primary btn-lift"
              >
                {editPagoLoading ? <><Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : <><CheckCircle size={14} /> Guardar cobro</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Crear nota de crédito ──────────────────────────────────────── */}
      {showNotaCredito && comprobanteActual && (
        <div className="modal-overlay-dark">
          <div className="modal-card" style={{ maxWidth: 480 }}>
            <div className="modal-hdr">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <FileText size={18} style={{ color: 'var(--accent-primary)' }} />
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Crear Nota de Crédito
                </h2>
              </div>
              <button onClick={() => setShowNotaCredito(false)} className="icon-btn" aria-label="Cerrar">
                <X size={16} />
              </button>
            </div>

            <div className="modal-body-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="alert-inline alert-warning">
                <AlertCircle size={14} style={{ flexShrink: 0 }} />
                <span>
                  Se creará una Nota de Crédito en borrador vinculada al comprobante{' '}
                  <strong>#{comprobanteActual.numero}</strong> por ${(comprobanteActual.total || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })}.
                  Deberás emitirla manualmente en ARCA desde el detalle de la nota.
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                {[
                  ['Tipo', 'Nota de Crédito'],
                  ['Comprobante original', `#${comprobanteActual.numero}`],
                  ['Cliente', (comprobanteActual as any).customer?.name || comprobanteActual.condicion_fiscal || 'Consumidor Final'],
                  ['Total', `$${(comprobanteActual.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{value}</span>
                  </div>
                ))}
              </div>

              <div>
                <label className="label-caps">Motivo (opcional)</label>
                <input
                  type="text"
                  value={notaCreditoMotivo}
                  onChange={e => setNotaCreditoMotivo(e.target.value)}
                  placeholder="Ej: Error en precio, devolución, duplicado..."
                  className="form-control"
                  autoFocus
                />
              </div>
            </div>

            <div className="modal-ftr" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNotaCredito(false)} className="btn btn-ghost" disabled={notaCreditoLoading}>
                Cancelar
              </button>
              <button
                onClick={() => void handleCrearNotaCredito()}
                disabled={notaCreditoLoading}
                className="btn btn-primary btn-lift"
              >
                {notaCreditoLoading
                  ? <><Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> Creando...</>
                  : <><FileText size={14} /> Crear nota de crédito</>
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Widget de estado de cobro mejorado ────────────────────────────────────────

const MEDIO_LABELS: Record<string, string> = {
  efectivo:        'Efectivo',
  transferencia:   'Transferencia',
  tarjeta_debito:  'Débito',
  tarjeta_credito: 'Crédito',
  qr:              'QR / MercadoPago',
  mixto:           'Mixto',
  cuenta_corriente:'Cuenta corriente',
  otro:            'Otro',
};

function EstadoCobroWidget({
  comprobante,
  onEditarCobro,
}: {
  comprobante: any;
  onEditarCobro: () => void;
}) {
  const tipo    = (comprobante.tipo || comprobante.type) as string | undefined;
  const total   = Number(comprobante.total || 0);

  const fmt = (n: number) =>
    `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Nota de crédito: no es un cobro, es un ajuste/devolución ─────────────
  if (tipo === 'nota_credito') {
    return (
      <div data-testid="estado-cobro-widget" style={{
        marginTop: '1rem', borderRadius: '0.75rem', overflow: 'hidden',
        border: '1px solid rgba(99,102,241,0.2)',
        background: 'rgba(99,102,241,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 0.875rem' }}>
          <FileText size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-primary)' }}>
            Nota de crédito
          </span>
        </div>
        <div style={{ padding: '0 0.875rem 0.625rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--text-subtle)' }}>Tipo</span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Devolución / ajuste</span>
          </div>
          {total > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
              <span style={{ color: 'var(--text-subtle)' }}>Importe de ajuste</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent-primary)' }}>
                {fmt(total)}
              </span>
            </div>
          )}
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.4 }}>
            Este comprobante no genera cobro en caja.
          </p>
        </div>
      </div>
    );
  }

  // ── Comprobantes normales (remito, factura_a, factura_c) ──────────────────
  const estado   = comprobante.estado_comercial as string | undefined;
  const cobrado  = Number(comprobante.total_cobrado || 0);
  const saldo    = Number(comprobante.saldo_pendiente || 0);
  const pagos    = (comprobante.pagos as any[] | undefined) || [];
  const metodo   = pagos[0]?.payment_method as string | undefined;

  const isPagado  = estado === 'pagado'  || (cobrado > 0 && saldo <= 0.01);
  const isParcial = estado === 'parcial' || (cobrado > 0 && saldo > 0.01);

  const color = isPagado ? '#34d399' : isParcial ? '#fbbf24' : '#f59e0b';
  const bg    = isPagado ? 'rgba(52,211,153,0.07)' : isParcial ? 'rgba(251,191,36,0.07)' : 'rgba(245,158,11,0.07)';
  const bdr   = isPagado ? 'rgba(52,211,153,0.25)'  : isParcial ? 'rgba(251,191,36,0.25)'  : 'rgba(245,158,11,0.25)';
  const label = isPagado ? 'Cobrado' : isParcial ? 'Pago parcial' : 'Pendiente de cobro';

  return (
    <div data-testid="estado-cobro-widget" style={{ marginTop: '1rem', borderRadius: '0.75rem', border: `1px solid ${bdr}`, background: bg, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.625rem 0.875rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Wallet size={14} style={{ color }} />
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color }}>{label}</span>
        </div>
        <button
          data-testid="edit-payment-button"
          onClick={onEditarCobro}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.4rem', borderRadius: 4 }}
          title="Editar cobro"
        >
          <Edit2 size={11} /> Editar
        </button>
      </div>

      {/* Detalle */}
      <div style={{ padding: '0 0.875rem 0.625rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {metodo && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--text-subtle)' }}>Medio</span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{MEDIO_LABELS[metodo] || metodo}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
          <span style={{ color: 'var(--text-subtle)' }}>Cobrado</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color }}>{fmt(cobrado)}</span>
        </div>
        {saldo > 0.01 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--text-subtle)' }}>Saldo pendiente</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f87171' }}>{fmt(saldo)}</span>
          </div>
        )}
        {isPagado && saldo <= 0.01 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--text-subtle)' }}>Saldo</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#34d399' }}>$0,00</span>
          </div>
        )}
      </div>
    </div>
  );
}
