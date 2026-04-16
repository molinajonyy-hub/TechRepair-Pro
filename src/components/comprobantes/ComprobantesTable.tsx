import { useState } from 'react';
import { Link } from 'react-router-dom';
import { 
  FileText, 
  Receipt, 
  RotateCcw, 
  Eye, 
  Filter,
  Search,
  ChevronDown,
  FileSpreadsheet,
  Printer
} from 'lucide-react';
import { TipoComprobante, Comprobante } from '../../hooks/useComprobantes';

interface ComprobantesTableProps {
  comprobantes: Comprobante[];
}

const tipoConfig: Record<TipoComprobante, { 
  label: string; 
  icon: React.ElementType; 
  color: string;
  bgColor: string;
}> = {
  factura_a: {
    label: 'Factura A',
    icon: Receipt,
    color: '#818cf8',
    bgColor: 'rgba(99, 102, 241, 0.1)'
  },
  factura_c: {
    label: 'Factura C',
    icon: FileText,
    color: '#34d399',
    bgColor: 'rgba(16, 185, 129, 0.1)'
  },
  remito: {
    label: 'Remito',
    icon: FileText,
    color: '#fbbf24',
    bgColor: 'rgba(245, 158, 11, 0.1)'
  },
  nota_credito: {
    label: 'Nota Crédito',
    icon: RotateCcw,
    color: '#f87171',
    bgColor: 'rgba(239, 68, 68, 0.1)'
  }
};

const estadoConfig: Record<string, { 
  label: string; 
  color: string; 
  bgColor: string;
}> = {
  borrador: { 
    label: 'Borrador', 
    color: '#fbbf24', 
    bgColor: 'rgba(245, 158, 11, 0.1)' 
  },
  emitido: { 
    label: 'Emitido', 
    color: '#34d399', 
    bgColor: 'rgba(16, 185, 129, 0.1)' 
  },
  anulado: { 
    label: 'Anulado', 
    color: '#f87171', 
    bgColor: 'rgba(239, 68, 68, 0.1)' 
  }
};

export function ComprobantesTable({ comprobantes }: ComprobantesTableProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [tipoFilter, setTipoFilter] = useState<TipoComprobante | 'todos'>('todos');
  const [estadoFilter, setEstadoFilter] = useState<'todos' | 'borrador' | 'emitido' | 'anulado'>('todos');
  const [showFilters, setShowFilters] = useState(false);

  const filteredComprobantes = comprobantes.filter(comp => {
    const matchesSearch = searchTerm === '' || 
      comp.numero?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ((comp as any).cliente_nombre?.toLowerCase().includes(searchTerm.toLowerCase())) ||
      comp.tipo.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesTipo = tipoFilter === 'todos' || comp.tipo === tipoFilter;
    const matchesEstado = estadoFilter === 'todos' || comp.estado === estadoFilter;
    
    return matchesSearch && matchesTipo && matchesEstado;
  });

  const formatCurrency = (value: number, currency?: string) => {
    const curr = currency === 'USD' ? 'USD' : 'ARS';
    return new Intl.NumberFormat(curr === 'USD' ? 'en-US' : 'es-AR', {
      style: 'currency',
      currency: curr
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const exportToCSV = (data: Comprobante[]) => {
    if (data.length === 0) {
      alert('No hay comprobantes para exportar');
      return;
    }

    const headers = ['Tipo', 'Número', 'Fecha', 'Cliente', 'Moneda', 'Total', 'Estado'];
    const rows = data.map(comp => [
      tipoConfig[comp.tipo].label,
      comp.numero || '-',
      formatDate(comp.fecha),
      (comp as any).cliente_nombre || 'Sin cliente',
      (comp as any).currency || 'ARS',
      comp.total.toFixed(2),
      estadoConfig[comp.estado].label
    ]);

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `comprobantes_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Search & Filters Bar */}
      <div style={{
        padding: '1rem',
        backgroundColor: '#0b1220',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '0.75rem'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Search Input */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search style={{ 
              position: 'absolute', 
              left: '1rem', 
              width: '20px', 
              height: '20px', 
              color: '#64748b' 
            }} />
            <input
              type="text"
              placeholder="Buscar comprobantes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                paddingLeft: '3rem',
                paddingRight: '1rem',
                paddingTop: '0.75rem',
                paddingBottom: '0.75rem',
                backgroundColor: '#111827',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '0.5rem',
                color: '#e5e7eb',
                outline: 'none'
              }}
            />
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {/* Filter Button */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1rem',
                backgroundColor: '#111827',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '0.5rem',
                color: '#94a3b8',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#1e293b';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#111827';
              }}
            >
              <Filter size={18} />
              <span>Filtros</span>
              <ChevronDown size={16} style={{ transform: showFilters ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
            </button>

            {/* Export Button */}
            <button
              onClick={() => exportToCSV(filteredComprobantes)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1rem',
                backgroundColor: '#111827',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '0.5rem',
                color: '#94a3b8',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#1e293b';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#111827';
              }}
            >
              <FileSpreadsheet size={18} />
              <span>Exportar</span>
            </button>

            {/* Print Button */}
            <button
              onClick={() => window.print()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem',
                backgroundColor: '#111827',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '0.5rem',
                color: '#94a3b8',
                cursor: 'pointer',
                transition: 'background-color 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#1e293b';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#111827';
              }}
            >
              <Printer size={18} />
            </button>
          </div>

          {/* Expandable Filters */}
          {showFilters && (
            <div style={{
              marginTop: '1rem',
              paddingTop: '1rem',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem'
            }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  Tipo de Comprobante
                </label>
                <select
                  value={tipoFilter}
                  onChange={(e) => setTipoFilter(e.target.value as TipoComprobante | 'todos')}
                  style={{
                    width: '100%',
                    padding: '0.625rem',
                    backgroundColor: '#111827',
                    border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: '0.5rem',
                    color: '#e5e7eb',
                    outline: 'none'
                  }}
                >
                  <option value="todos">Todos los tipos</option>
                  <option value="factura_a">Factura A</option>
                  <option value="factura_c">Factura C</option>
                  <option value="remito">Remito</option>
                  <option value="nota_credito">Nota de Crédito</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  Estado
                </label>
                <select
                  value={estadoFilter}
                  onChange={(e) => setEstadoFilter(e.target.value as any)}
                  style={{
                    width: '100%',
                    padding: '0.625rem',
                    backgroundColor: '#111827',
                    border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: '0.5rem',
                    color: '#e5e7eb',
                    outline: 'none'
                  }}
                >
                  <option value="todos">Todos los estados</option>
                  <option value="borrador">Borrador</option>
                  <option value="emitido">Emitido</option>
                  <option value="anulado">Anulado</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div style={{
        backgroundColor: '#0b1220',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '0.75rem',
        overflow: 'hidden'
      }}>
        {filteredComprobantes.length === 0 ? (
          <div style={{
            padding: '3rem',
            textAlign: 'center',
            color: '#64748b'
          }}>
            <FileText size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
            <p style={{ fontSize: '1rem', margin: 0 }}>
              {searchTerm || tipoFilter !== 'todos' || estadoFilter !== 'todos' 
                ? 'No se encontraron comprobantes con los filtros aplicados' 
                : 'No hay comprobantes registrados'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <th style={{ 
                    padding: '1rem', 
                    textAlign: 'left', 
                    fontSize: '0.875rem', 
                    fontWeight: 500, 
                    color: '#94a3b8' 
                  }}>
                    Tipo
                  </th>
                  <th style={{ 
                    padding: '1rem', 
                    textAlign: 'left', 
                    fontSize: '0.875rem', 
                    fontWeight: 500, 
                    color: '#94a3b8' 
                  }}>
                    Número
                  </th>
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
                    Cliente
                  </th>
                  <th style={{ 
                    padding: '1rem', 
                    textAlign: 'right', 
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
                {filteredComprobantes.map((comprobante) => {
                  const Icon = tipoConfig[comprobante.tipo].icon;
                  const estado = estadoConfig[comprobante.estado];
                  
                  return (
                    <tr 
                      key={comprobante.id}
                      style={{ 
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        transition: 'background-color 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.02)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{
                            padding: '0.375rem',
                            backgroundColor: tipoConfig[comprobante.tipo].bgColor,
                            borderRadius: '0.375rem'
                          }}>
                            <Icon size={16} style={{ color: tipoConfig[comprobante.tipo].color }} />
                          </div>
                          <span style={{ color: '#e5e7eb', fontSize: '0.875rem' }}>
                            {tipoConfig[comprobante.tipo].label}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                          {comprobante.numero || '-'}
                        </span>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                          {formatDate(comprobante.fecha)}
                        </span>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                          {(comprobante as any).cliente_nombre || 'Sin cliente'}
                        </span>
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        {comprobante.tipo === 'remito' ? (() => {
                          const arsTotal = comprobante.total_ars ?? comprobante.total
                          const usdTotal = comprobante.total_usd ?? 0
                          const hasBoth  = arsTotal > 0 && usdTotal > 0
                          const onlyUSD  = usdTotal > 0 && arsTotal === 0
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
                              {/* ARS row */}
                              {(arsTotal > 0 || (!hasBoth && !onlyUSD)) && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ color: '#ffffff', fontSize: '0.875rem', fontWeight: 500 }}>
                                    {formatCurrency(arsTotal, 'ARS')}
                                  </span>
                                  <span style={{
                                    fontSize: '0.6rem', fontWeight: 700, padding: '0.1rem 0.35rem',
                                    borderRadius: 3, background: 'rgba(99,102,241,0.15)',
                                    color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)',
                                  }}>ARS</span>
                                </div>
                              )}
                              {/* USD row */}
                              {usdTotal > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ color: '#34d399', fontSize: '0.875rem', fontWeight: 500 }}>
                                    {formatCurrency(usdTotal, 'USD')}
                                  </span>
                                  <span style={{
                                    fontSize: '0.6rem', fontWeight: 700, padding: '0.1rem 0.35rem',
                                    borderRadius: 3, background: 'rgba(16,185,129,0.15)',
                                    color: '#34d399', border: '1px solid rgba(16,185,129,0.3)',
                                  }}>USD</span>
                                </div>
                              )}
                            </div>
                          )
                        })() : (
                          <span style={{ color: '#ffffff', fontSize: '0.875rem', fontWeight: 500 }}>
                            {formatCurrency(comprobante.total, 'ARS')}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{
                          padding: '0.25rem 0.75rem',
                          backgroundColor: estado.bgColor,
                          color: estado.color,
                          borderRadius: '9999px',
                          fontSize: '0.75rem',
                          fontWeight: 500
                        }}>
                          {estado.label}
                        </span>
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        <Link
                          to={`/comprobantes/${comprobante.id}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.5rem 1rem',
                            backgroundColor: '#4f46e5',
                            color: '#ffffff',
                            borderRadius: '0.5rem',
                            textDecoration: 'none',
                            fontSize: '0.875rem',
                            transition: 'background-color 0.15s ease'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = '#4338ca';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '#4f46e5';
                          }}
                        >
                          <Eye size={16} />
                          Ver
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
