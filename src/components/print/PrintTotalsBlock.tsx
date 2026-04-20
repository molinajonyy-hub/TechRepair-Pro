import React from 'react';

interface PrintTotalsBlockProps {
  totals: {
    subtotal?: number;
    tax?: number;
    total: number;
  };
  settings?: {
    mostrar_precios?: boolean;
  };
}

export const PrintTotalsBlock: React.FC<PrintTotalsBlockProps> = ({ totals, settings }) => {
  if (!settings?.mostrar_precios) {
    return null;
  }

  return (
    <div style={styles.block}>
      <h3 style={styles.blockTitle}>TOTAL DEL SERVICIO</h3>
      <div style={styles.totalsContent}>
        {totals.subtotal !== undefined && (
          <div style={styles.row}>
            <span style={styles.label}>Subtotal:</span>
            <span style={styles.value}>${totals.subtotal.toFixed(2)}</span>
          </div>
        )}
        {totals.tax !== undefined && totals.tax > 0 && (
          <div style={styles.row}>
            <span style={styles.label}>IVA (21%):</span>
            <span style={styles.value}>${totals.tax.toFixed(2)}</span>
          </div>
        )}
        <div style={styles.totalRow}>
          <span style={styles.totalLabel}>TOTAL:</span>
          <span style={styles.totalValue}>${totals.total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
};

const styles = {
  block: {
    marginBottom: '1.5rem',
    padding: '1rem',
    border: '2px solid #000',
    borderRadius: '4px',
    backgroundColor: '#fff',
  } as React.CSSProperties,
  blockTitle: {
    fontSize: '1rem',
    fontWeight: 'bold',
    margin: '0 0 1rem 0',
    color: '#000',
    borderBottom: '1px solid #ddd',
    paddingBottom: '0.5rem',
  } as React.CSSProperties,
  totalsContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '1rem',
  } as React.CSSProperties,
  label: {
    color: '#333',
  } as React.CSSProperties,
  value: {
    fontWeight: 'bold',
    color: '#000',
  } as React.CSSProperties,
  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '1.25rem',
    fontWeight: 'bold',
    marginTop: '0.5rem',
    paddingTop: '0.5rem',
    borderTop: '1px solid #000',
  } as React.CSSProperties,
  totalLabel: {
    color: '#000',
  } as React.CSSProperties,
  totalValue: {
    color: '#000',
  } as React.CSSProperties,
};
