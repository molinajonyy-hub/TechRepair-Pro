import { useEffect, useState } from 'react';
import { Plus, RefreshCw, FileText, TrendingUp, Receipt } from 'lucide-react';
import { useComprobantes, TipoComprobante } from '../hooks/useComprobantes';
import { ComprobantesTable } from '../components/comprobantes/ComprobantesTable';
import { ModalCrearComprobante } from '../components/comprobantes/ModalCrearComprobante';
import { Loader } from '../components/ui/Loader';
import { useAuth } from '../contexts/AuthContext';
import ArcaService from '../services/arcaService';

export default function ComprobantesPage() {
  const { businessId } = useAuth();
  const {
    comprobantes,
    loading,
    error,
    listarComprobantes,
    limpiarError,
    crearComprobanteIndependiente
  } = useComprobantes();

  const [showModal, setShowModal] = useState(false);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    cargarComprobantes();
  }, [listarComprobantes]);

  const cargarComprobantes = async () => {
    await listarComprobantes();
  };

  const handleCrearComprobante = async (data: {
    tipo: TipoComprobante;
    puntoVenta: string;
    condicionFiscal: string;
    clienteId: string | null;
    exchangeRate?: number;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      currency?: 'ARS' | 'USD';
      exchange_rate?: number;
      inventory_id?: string;
    }[];
    esElectronica?: boolean;
  }) => {
    setCreando(true);
    try {
      // Primero crear el comprobante internamente
      await crearComprobanteIndependiente({
        tipo: data.tipo,
        punto_venta: data.puntoVenta,
        condicion_fiscal: data.condicionFiscal,
        customer_id: data.clienteId,
        exchange_rate: data.exchangeRate,
        items: data.items
      });

      // Si es electrónica, emitir vía ARCA
      if (data.esElectronica && businessId) {
        const resultadoArca = await ArcaService.emitirFactura(businessId, {
          tipo: data.tipo,
          punto_venta: parseInt(data.puntoVenta),
          condicion_fiscal: data.condicionFiscal,
          cliente_id: data.clienteId ?? undefined,
          items: data.items
        });

        if (!resultadoArca.success) {
          alert('Comprobante creado pero error al emitir electrónicamente: ' + resultadoArca.error);
        } else {
          alert('Comprobante creado y emitido electrónicamente\nCAE: ' + resultadoArca.cae + '\nVencimiento: ' + resultadoArca.caeVencimiento);
        }
      }

      setShowModal(false);
      await cargarComprobantes();
    } catch (err: any) {
      console.error('Error creando comprobante:', err);
      alert('Error: ' + (err.message || 'Error desconocido al crear comprobante'));
    } finally {
      setCreando(false);
    }
  };

  // Calcular estadísticas
  const totalEmitido = comprobantes.filter(c => c.estado === 'emitido').length;
  const totalBorrador = comprobantes.filter(c => c.estado === 'borrador').length;
  const montoTotal = comprobantes
    .filter(c => c.estado === 'emitido')
    .reduce((sum, c) => sum + c.total, 0);

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
          <button onClick={cargarComprobantes} disabled={loading} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.875rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.8rem'
          }}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
          <button onClick={() => setShowModal(true)} disabled={creando} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.625rem 1.25rem',
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            border: 'none', color: '#ffffff', borderRadius: '0.625rem',
            cursor: creando ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.875rem',
            boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
          }}>
            <Plus size={18} />
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

        {/* Card 2 - Monto */}
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
              Total Facturado
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            ${montoTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#64748b' }}>
            En comprobantes emitidos
          </div>
        </div>

        {/* Card 3 - Promedio */}
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
              Promedio
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            ${totalEmitido > 0 ? (montoTotal / totalEmitido).toFixed(2) : '0.00'}
          </div>
          <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#64748b' }}>
            Por comprobante emitido
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
          <button
            onClick={() => setShowModal(true)}
            style={{
              padding: '0.625rem 1.25rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.625rem',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: 600,
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
            }}
          >
            <Plus size={18} />
            Crear Comprobante
          </button>
        </div>
      )}

      {/* Modal Crear Comprobante */}
      <ModalCrearComprobante
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCrear={handleCrearComprobante}
        loading={creando}
      />
    </div>
  );
}
