import React from 'react';
import { BusinessSettings } from '../../lib/businessSettings';

interface PrintHeaderProps {
  settings: BusinessSettings;
  title?: string;
  orderNumber?: string;
}

export const PrintHeader: React.FC<PrintHeaderProps> = ({ 
  settings, 
  title = 'ORDEN DE SERVICIO',
  orderNumber 
}) => {
  return (
    <div style={styles.header}>
      <div style={styles.headerTop}>
        {settings.logo_url && (
          <img 
            src={settings.logo_url} 
            alt={settings.nombre_empresa}
            style={styles.logo}
          />
        )}
        <div style={styles.companyInfo}>
          <h1 style={styles.companyName}>{settings.nombre_empresa}</h1>
          <p style={styles.companyDetail}>{settings.direccion}</p>
          <p style={styles.companyDetail}>
            Tel: {settings.telefono} | Email: {settings.email}
          </p>
          {settings.cuit && (
            <p style={styles.companyDetail}>CUIT: {settings.cuit}</p>
          )}
        </div>
      </div>
      <div style={styles.titleSection}>
        <h2 style={styles.title}>{title}</h2>
        {orderNumber && (
          <p style={styles.orderNumber}>Nº {orderNumber}</p>
        )}
      </div>
    </div>
  );
};

const styles = {
  header: {
    marginBottom: '2rem',
    paddingBottom: '1rem',
    borderBottom: '2px solid #000',
  } as React.CSSProperties,
  headerTop: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '1rem',
  } as React.CSSProperties,
  logo: {
    width: '80px',
    height: '80px',
    objectFit: 'contain',
  } as React.CSSProperties,
  companyInfo: {
    flex: 1,
  } as React.CSSProperties,
  companyName: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    margin: '0 0 0.5rem 0',
    color: '#000',
  } as React.CSSProperties,
  companyDetail: {
    fontSize: '0.875rem',
    margin: '0.25rem 0',
    color: '#333',
  } as React.CSSProperties,
  titleSection: {
    textAlign: 'center',
    marginTop: '1rem',
  } as React.CSSProperties,
  title: {
    fontSize: '1.75rem',
    fontWeight: 'bold',
    margin: '0',
    color: '#000',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  orderNumber: {
    fontSize: '1.25rem',
    fontWeight: 'bold',
    margin: '0.5rem 0 0 0',
    color: '#000',
  } as React.CSSProperties,
};
