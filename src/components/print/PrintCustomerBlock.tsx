import React from 'react';

interface PrintCustomerBlockProps {
  customer: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
  };
}

export const PrintCustomerBlock: React.FC<PrintCustomerBlockProps> = ({ customer }) => {
  return (
    <div style={styles.block}>
      <h3 style={styles.blockTitle}>DATOS DEL CLIENTE</h3>
      <div style={styles.blockContent}>
        <p style={styles.row}>
          <span style={styles.label}>Nombre:</span>
          <span style={styles.value}>{customer.name}</span>
        </p>
        {customer.phone && (
          <p style={styles.row}>
            <span style={styles.label}>Teléfono:</span>
            <span style={styles.value}>{customer.phone}</span>
          </p>
        )}
        {customer.email && (
          <p style={styles.row}>
            <span style={styles.label}>Email:</span>
            <span style={styles.value}>{customer.email}</span>
          </p>
        )}
        {customer.address && (
          <p style={styles.row}>
            <span style={styles.label}>Dirección:</span>
            <span style={styles.value}>{customer.address}</span>
          </p>
        )}
      </div>
    </div>
  );
};

const styles = {
  block: {
    marginBottom: '1.5rem',
    padding: '1rem',
    border: '1px solid #ddd',
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
  blockContent: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '0.5rem',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    margin: '0',
    fontSize: '0.875rem',
  } as React.CSSProperties,
  label: {
    fontWeight: 'bold',
    color: '#333',
    minWidth: '100px',
  } as React.CSSProperties,
  value: {
    color: '#000',
    flex: 1,
  } as React.CSSProperties,
};
