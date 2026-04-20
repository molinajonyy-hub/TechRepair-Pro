import React from 'react';
import { getBusinessSettings } from '../../lib/businessSettings';

interface OrderPrintTicketProps {
  order: {
    id: string;
    created_at: string;
    status: string;
    technician?: string;
    customer: {
      name: string;
      phone?: string;
      email?: string;
      address?: string;
    };
    device: {
      type?: string;
      brand?: string;
      model?: string;
      imei?: string;
      serial?: string;
      color?: string;
      accessories?: string;
    };
    reported_issue?: string;
    diagnosis?: string;
    observations?: string;
    final_total?: number;
  };
  ref?: React.RefObject<HTMLDivElement>;
}

export const OrderPrintTicket = React.forwardRef<HTMLDivElement, OrderPrintTicketProps>(
  ({ order }, ref) => {
    const settings = getBusinessSettings();
    const orderNumber = order.id.slice(0, 8);
    const orderDate = new Date(order.created_at).toLocaleDateString('es-ES');
    const ticketWidth = settings.ticket_width || 58;

    return (
      <div ref={ref} style={{ ...styles.container, maxWidth: ticketWidth === 58 ? '58mm' : '80mm' }}>
        <div style={styles.ticket}>
          {/* Header */}
          <div style={styles.ticketHeader}>
            {settings.logo_url && (
              <img 
                src={settings.logo_url} 
                alt={settings.nombre_empresa}
                style={styles.ticketLogo}
              />
            )}
            <h2 style={styles.ticketCompanyName}>{settings.nombre_empresa}</h2>
            <p style={styles.ticketContact}>
              {settings.telefono}
            </p>
            {settings.cuit && (
              <p style={styles.ticketContact}>CUIT: {settings.cuit}</p>
            )}
          </div>

          <div style={styles.divider} />

          {/* Order Title */}
          <div style={styles.ticketTitle}>
            <h3 style={styles.ticketTitleText}>ORDEN DE SERVICIO</h3>
            <p style={styles.ticketOrderNumber}>#{orderNumber}</p>
          </div>

          <div style={styles.divider} />

          {/* Order Info */}
          <div style={styles.ticketSection}>
            <p style={styles.ticketInfo}>
              <strong>Fecha:</strong> {orderDate}
            </p>
            <p style={styles.ticketInfo}>
              <strong>Estado:</strong> {order.status.toUpperCase()}
            </p>
            {order.technician && (
              <p style={styles.ticketInfo}>
                <strong>Técnico:</strong> {order.technician}
              </p>
            )}
          </div>

          <div style={styles.divider} />

          {/* Customer */}
          <div style={styles.ticketSection}>
            <h4 style={styles.ticketSectionTitle}>CLIENTE</h4>
            <p style={styles.ticketText}>{order.customer.name}</p>
            {order.customer.phone && (
              <p style={styles.ticketText}>{order.customer.phone}</p>
            )}
          </div>

          <div style={styles.divider} />

          {/* Device */}
          <div style={styles.ticketSection}>
            <h4 style={styles.ticketSectionTitle}>EQUIPO</h4>
            <p style={styles.ticketText}>
              {order.device.type} {order.device.brand} {order.device.model}
            </p>
            {order.device.imei && (
              <p style={styles.ticketText}>IMEI: {order.device.imei}</p>
            )}
            {order.device.serial && (
              <p style={styles.ticketText}>Serie: {order.device.serial}</p>
            )}
          </div>

          <div style={styles.divider} />

          {/* Service */}
          <div style={styles.ticketSection}>
            <h4 style={styles.ticketSectionTitle}>FALLA</h4>
            <p style={styles.ticketText}>{order.reported_issue || '-'}</p>
          </div>

          {settings.mostrar_diagnostico && order.diagnosis && (
            <>
              <div style={styles.divider} />
              <div style={styles.ticketSection}>
                <h4 style={styles.ticketSectionTitle}>DIAGNÓSTICO</h4>
                <p style={styles.ticketText}>{order.diagnosis}</p>
              </div>
            </>
          )}

          {order.observations && (
            <>
              <div style={styles.divider} />
              <div style={styles.ticketSection}>
                <h4 style={styles.ticketSectionTitle}>OBSERVACIONES</h4>
                <p style={styles.ticketText}>{order.observations}</p>
              </div>
            </>
          )}

          {settings.mostrar_precios && order.final_total && (
            <>
              <div style={styles.divider} />
              <div style={styles.ticketTotal}>
                <p style={styles.ticketTotalLabel}>TOTAL</p>
                <p style={styles.ticketTotalValue}>${order.final_total.toFixed(2)}</p>
              </div>
            </>
          )}

          <div style={styles.divider} />

          {/* Footer */}
          <div style={styles.ticketFooter}>
            <p style={styles.ticketFooterText}>
              * El equipo queda en depósito por 90 días
            </p>
            <p style={styles.ticketFooterText}>
              * No nos hacemos responsables por pérdida de datos
            </p>
            <p style={styles.ticketFooterText}>
              {settings.email}
            </p>
          </div>

          {settings.mostrar_firma && (
            <>
              <div style={styles.divider} />
              <div style={styles.ticketSignature}>
                <p style={styles.ticketSignatureText}>Firma Cliente</p>
                <div style={styles.ticketSignatureLine} />
              </div>
            </>
          )}
        </div>

        <style>{`
          @media print {
            @page {
              margin: 0;
              size: ${ticketWidth}mm auto;
            }
            body {
              margin: 0;
              padding: 0;
            }
          }
        `}</style>
      </div>
    );
  }
);

OrderPrintTicket.displayName = 'OrderPrintTicket';

const styles = {
  container: {
    padding: '10px',
    backgroundColor: '#f5f5f5',
  } as React.CSSProperties,
  ticket: {
    backgroundColor: '#fff',
    padding: '10px',
    fontFamily: 'monospace',
    fontSize: '12px',
    lineHeight: '1.4',
    color: '#000',
  } as React.CSSProperties,
  ticketHeader: {
    textAlign: 'center',
    marginBottom: '10px',
  } as React.CSSProperties,
  ticketLogo: {
    width: '40px',
    height: '40px',
    objectFit: 'contain',
    marginBottom: '5px',
  } as React.CSSProperties,
  ticketCompanyName: {
    fontSize: '14px',
    fontWeight: 'bold',
    margin: '5px 0',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  ticketContact: {
    fontSize: '10px',
    margin: '2px 0',
  } as React.CSSProperties,
  ticketTitle: {
    textAlign: 'center',
    marginBottom: '10px',
  } as React.CSSProperties,
  ticketTitleText: {
    fontSize: '16px',
    fontWeight: 'bold',
    margin: '0 0 5px 0',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  ticketOrderNumber: {
    fontSize: '18px',
    fontWeight: 'bold',
    margin: '0',
  } as React.CSSProperties,
  ticketSection: {
    marginBottom: '8px',
  } as React.CSSProperties,
  ticketSectionTitle: {
    fontSize: '12px',
    fontWeight: 'bold',
    margin: '0 0 3px 0',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  ticketInfo: {
    fontSize: '11px',
    margin: '2px 0',
  } as React.CSSProperties,
  ticketText: {
    fontSize: '11px',
    margin: '2px 0',
    wordWrap: 'break-word' as const,
  } as React.CSSProperties,
  ticketTotal: {
    textAlign: 'center',
    padding: '8px 0',
    borderTop: '1px dashed #000',
    borderBottom: '1px dashed #000',
    marginTop: '8px',
  } as React.CSSProperties,
  ticketTotalLabel: {
    fontSize: '12px',
    fontWeight: 'bold',
    margin: '0',
  } as React.CSSProperties,
  ticketTotalValue: {
    fontSize: '16px',
    fontWeight: 'bold',
    margin: '0',
  } as React.CSSProperties,
  ticketFooter: {
    marginTop: '10px',
    textAlign: 'center',
    fontSize: '9px',
  } as React.CSSProperties,
  ticketFooterText: {
    margin: '2px 0',
  } as React.CSSProperties,
  ticketSignature: {
    marginTop: '15px',
    textAlign: 'center',
  } as React.CSSProperties,
  ticketSignatureText: {
    fontSize: '11px',
    fontWeight: 'bold',
    margin: '0 0 5px 0',
  } as React.CSSProperties,
  ticketSignatureLine: {
    height: '30px',
    borderBottom: '1px solid #000',
  } as React.CSSProperties,
  divider: {
    height: '1px',
    backgroundColor: '#000',
    margin: '8px 0',
  } as React.CSSProperties,
};
