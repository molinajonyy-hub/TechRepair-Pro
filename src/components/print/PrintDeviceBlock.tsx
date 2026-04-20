import React from 'react';

interface PrintDeviceBlockProps {
  device: {
    type?: string;
    brand?: string;
    model?: string;
    imei?: string;
    serial?: string;
    color?: string;
    accessories?: string;
  };
}

export const PrintDeviceBlock: React.FC<PrintDeviceBlockProps> = ({ device }) => {
  return (
    <div style={styles.block}>
      <h3 style={styles.blockTitle}>DATOS DEL EQUIPO</h3>
      <div style={styles.blockContent}>
        <p style={styles.row}>
          <span style={styles.label}>Tipo:</span>
          <span style={styles.value}>{device.type || '-'}</span>
        </p>
        <p style={styles.row}>
          <span style={styles.label}>Marca:</span>
          <span style={styles.value}>{device.brand || '-'}</span>
        </p>
        <p style={styles.row}>
          <span style={styles.label}>Modelo:</span>
          <span style={styles.value}>{device.model || '-'}</span>
        </p>
        {device.imei && (
          <p style={styles.row}>
            <span style={styles.label}>IMEI:</span>
            <span style={styles.value}>{device.imei}</span>
          </p>
        )}
        {device.serial && (
          <p style={styles.row}>
            <span style={styles.label}>Serie:</span>
            <span style={styles.value}>{device.serial}</span>
          </p>
        )}
        {device.color && (
          <p style={styles.row}>
            <span style={styles.label}>Color:</span>
            <span style={styles.value}>{device.color}</span>
          </p>
        )}
        {device.accessories && (
          <p style={styles.row}>
            <span style={styles.label}>Accesorios:</span>
            <span style={styles.value}>{device.accessories}</span>
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
