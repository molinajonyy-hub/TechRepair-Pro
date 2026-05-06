import React from 'react';
import { getBusinessSettings } from '../../lib/businessSettings';
import { PrintHeader } from './PrintHeader';
import { PrintCustomerBlock } from './PrintCustomerBlock';
import { PrintDeviceBlock } from './PrintDeviceBlock';
import { PrintServiceBlock } from './PrintServiceBlock';
import { PrintTotalsBlock } from './PrintTotalsBlock';
import { PrintFooter } from './PrintFooter';

interface OrderPrintA4Props {
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
    parts_used?: string;
    labor?: string;
    observations?: string;
    estimated_total?: number;
    final_total?: number;
  };
  ref?: React.RefObject<HTMLDivElement>;
}

export const OrderPrintA4 = React.forwardRef<HTMLDivElement, OrderPrintA4Props>(
  ({ order }, ref) => {
    const settings = getBusinessSettings();
    const orderNumber = order.id.slice(0, 8);
    const orderDate = new Date(order.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: '2-digit', year: 'numeric' });

    const totals = {
      subtotal: order.estimated_total || order.final_total,
      tax: order.final_total ? (order.final_total * 0.21) : 0,
      total: order.final_total || order.estimated_total || 0,
    };

    return (
      <div ref={ref} style={styles.container}>
        <div style={styles.page}>
          <PrintHeader 
            settings={settings} 
            title="ORDEN DE SERVICIO"
            orderNumber={orderNumber}
          />

          <div style={styles.orderInfo}>
            <p style={styles.infoItem}>
              <strong>Fecha de Ingreso:</strong> {orderDate}
            </p>
            <p style={styles.infoItem}>
              <strong>Estado:</strong> {order.status.toUpperCase()}
            </p>
            {order.technician && (
              <p style={styles.infoItem}>
                <strong>Técnico:</strong> {order.technician}
              </p>
            )}
          </div>

          <PrintCustomerBlock customer={order.customer} />
          <PrintDeviceBlock device={order.device} />
          
          <PrintServiceBlock 
            service={{
              reported_issue: order.reported_issue,
              diagnosis: order.diagnosis,
              parts_used: order.parts_used,
              labor: order.labor,
              observations: order.observations,
            }}
            settings={settings}
          />

          <PrintTotalsBlock 
            totals={totals}
            settings={settings}
          />

          <PrintFooter 
            settings={settings}
            orderDate={orderDate}
            technician={order.technician}
          />
        </div>

        <style>{`
          @media print {
            @page {
              size: A4;
              margin: 0;
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

OrderPrintA4.displayName = 'OrderPrintA4';

const styles = {
  container: {
    padding: '20px',
    backgroundColor: '#f5f5f5',
  } as React.CSSProperties,
  page: {
    backgroundColor: '#fff',
    padding: '40px',
    maxWidth: '210mm',
    margin: '0 auto',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  } as React.CSSProperties,
  orderInfo: {
    display: 'flex',
    gap: '2rem',
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#f9f9f9',
    borderRadius: '4px',
  } as React.CSSProperties,
  infoItem: {
    margin: '0',
    fontSize: '0.875rem',
    color: '#333',
  } as React.CSSProperties,
};
