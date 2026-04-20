import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Package, DollarSign, Calendar, Building2, CheckCircle, XCircle, Eye } from 'lucide-react';
import { purchasesService, Purchase } from '../services/purchasesService';
import { useAuth } from '../contexts/AuthContext';

export function Purchases() {
  const { businessId, user } = useAuth();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (businessId) {
      loadData();
      return;
    }

    setPurchases([]);
    setLoading(false);
  }, [businessId]);

  const loadData = async () => {
    if (!businessId) {
      setPurchases([]);
      setLoading(false);
      return;
    }

    try {
      const purchasesData = await purchasesService.getAllPurchases(businessId);
      setPurchases(purchasesData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPurchase = async (purchaseId: string) => {
    if (!businessId) return;

    try {
      await purchasesService.confirmPurchase(purchaseId, businessId, user?.id || '');
      await loadData();
    } catch (error) {
      console.error('Error confirming purchase:', error);
      alert('Error al confirmar compra');
    }
  };

  const handleCancelPurchase = async (purchaseId: string) => {
    if (!confirm('¿Estás seguro de cancelar esta compra?')) return;
    
    try {
      await purchasesService.cancelPurchase(purchaseId, businessId || '', user?.id || '');
      await loadData();
    } catch (error) {
      console.error('Error cancelling purchase:', error);
      alert('Error al cancelar compra');
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: { backgroundColor: '#fef3c7', color: '#92400e' },
      confirmed: { backgroundColor: '#d1fae5', color: '#065f46' },
      cancelled: { backgroundColor: '#fee2e2', color: '#991b1b' }
    };
    
    const style = styles[status as keyof typeof styles] || styles.pending;
    
    return (
      <span style={{
        padding: '0.25rem 0.625rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 500,
        ...style
      }}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    );
  }

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
            <Building2 size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Compras a Proveedores</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona las compras de mercadería a proveedores</p>
          </div>
        </div>
        <button style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.625rem 1.25rem',
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          border: 'none', color: '#ffffff', borderRadius: '0.625rem',
          cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
          boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
        }}>
          <Plus size={18} />
          Nueva Compra
        </button>
      </div>

      {/* Summary Cards */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
        gap: '1rem', 
        marginBottom: '2rem' 
      }}>
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
              <Package size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Total Compras
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            {purchases.length}
          </div>
        </div>

        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.5rem',
              background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
              borderRadius: '0.5rem'
            }}>
              <DollarSign size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Pendientes
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            {purchases.filter(p => p.status === 'pending').length}
          </div>
        </div>

        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.5rem',
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              borderRadius: '0.5rem'
            }}>
              <CheckCircle size={20} color="#ffffff" />
            </div>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 500 }}>
              Confirmadas
            </span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ffffff' }}>
            {purchases.filter(p => p.status === 'confirmed').length}
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        overflow: 'hidden'
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'left', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Fecha
              </th>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'left', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Proveedor
              </th>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'left', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Factura
              </th>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'left', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Total
              </th>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'left', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Estado
              </th>
              <th style={{ 
                padding: '1rem', 
                textAlign: 'right', 
                fontSize: '0.875rem', 
                fontWeight: 500, 
                color: '#94a3b8' 
              }}>
                Acciones
              </th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((purchase) => (
              <tr key={purchase.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ffffff' }}>
                    <Calendar size={16} style={{ color: '#64748b' }} />
                    {new Date(purchase.purchase_date).toLocaleDateString('es-ES')}
                  </div>
                </td>
                <td style={{ padding: '1rem', color: '#94a3b8' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Building2 size={16} style={{ color: '#64748b' }} />
                    {purchase.supplier_id ? 'Proveedor' : '-'}
                  </div>
                </td>
                <td style={{ padding: '1rem', color: '#ffffff' }}>
                  {purchase.invoice_number || '-'}
                </td>
                <td style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <DollarSign size={16} style={{ color: '#10b981' }} />
                    <span style={{ fontWeight: 600, color: '#10b981' }}>
                      {purchase.total.toFixed(2)}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '1rem' }}>
                  {getStatusBadge(purchase.status)}
                </td>
                <td style={{ padding: '1rem', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button 
                      style={{
                        padding: '0.375rem 0.5rem',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        border: '1px solid rgba(99, 102, 241, 0.3)',
                        color: '#818cf8',
                        borderRadius: '0.375rem',
                        cursor: 'pointer'
                      }}
                    >
                      <Eye size={16} />
                    </button>
                    {purchase.status === 'pending' && (
                      <button 
                        onClick={() => handleConfirmPurchase(purchase.id)}
                        style={{
                          padding: '0.375rem 0.5rem',
                          backgroundColor: 'rgba(16, 185, 129, 0.1)',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          color: '#10b981',
                          borderRadius: '0.375rem',
                          cursor: 'pointer'
                        }}
                      >
                        <CheckCircle size={16} />
                      </button>
                    )}
                    {purchase.status !== 'cancelled' && (
                      <button 
                        onClick={() => handleCancelPurchase(purchase.id)}
                        style={{
                          padding: '0.375rem 0.5rem',
                          backgroundColor: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          color: '#f87171',
                          borderRadius: '0.375rem',
                          cursor: 'pointer'
                        }}
                      >
                        <XCircle size={16} />
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
