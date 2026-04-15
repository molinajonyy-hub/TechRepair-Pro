import React from 'react';

interface PrintFooterProps {
  settings?: {
    mostrar_firma?: boolean;
  };
  orderDate?: string;
  technician?: string;
}

export const PrintFooter: React.FC<PrintFooterProps> = ({ settings, orderDate, technician }) => {
  return (
    <div style={styles.footer}>
      <div style={styles.conditions}>
        <h4 style={styles.conditionsTitle}>CONDICIONES</h4>
        <ul style={styles.conditionsList}>
          <li style={styles.conditionItem}>
            El equipo queda en depósito por 90 días. Pasado este plazo, la empresa no se hace responsable.
          </li>
          <li style={styles.conditionItem}>
            La revisión diagnóstica tiene un costo de $XXX que se descuenta del total del servicio.
          </li>
          <li style={styles.conditionItem}>
            No nos hacemos responsables por pérdida de datos en dispositivos electrónicos.
          </li>
          <li style={styles.conditionItem}>
            El retiro del equipo implica aceptación del servicio realizado.
          </li>
        </ul>
      </div>

      {orderDate && (
        <div style={styles.dateSection}>
          <p style={styles.dateText}>Fecha de ingreso: {orderDate}</p>
          {technician && <p style={styles.dateText}>Técnico: {technician}</p>}
        </div>
      )}

      {settings?.mostrar_firma && (
        <div style={styles.signatures}>
          <div style={styles.signatureBox}>
            <p style={styles.signatureLabel}>Firma del Cliente</p>
            <div style={styles.signatureLine} />
          </div>
          <div style={styles.signatureBox}>
            <p style={styles.signatureLabel}>Firma del Técnico</p>
            <div style={styles.signatureLine} />
          </div>
        </div>
      )}
    </div>
  );
};

const styles = {
  footer: {
    marginTop: '2rem',
    paddingTop: '1rem',
    borderTop: '2px solid #000',
  } as React.CSSProperties,
  conditions: {
    marginBottom: '1.5rem',
  } as React.CSSProperties,
  conditionsTitle: {
    fontSize: '0.875rem',
    fontWeight: 'bold',
    margin: '0 0 0.5rem 0',
    color: '#000',
  } as React.CSSProperties,
  conditionsList: {
    margin: '0',
    paddingLeft: '1.25rem',
  } as React.CSSProperties,
  conditionItem: {
    fontSize: '0.75rem',
    margin: '0.25rem 0',
    color: '#333',
    lineHeight: '1.4',
  } as React.CSSProperties,
  dateSection: {
    marginBottom: '1.5rem',
  } as React.CSSProperties,
  dateText: {
    fontSize: '0.875rem',
    margin: '0.25rem 0',
    color: '#333',
  } as React.CSSProperties,
  signatures: {
    display: 'flex',
    gap: '2rem',
    justifyContent: 'space-between',
  } as React.CSSProperties,
  signatureBox: {
    flex: 1,
  } as React.CSSProperties,
  signatureLabel: {
    fontSize: '0.875rem',
    fontWeight: 'bold',
    margin: '0 0 0.5rem 0',
    color: '#000',
  } as React.CSSProperties,
  signatureLine: {
    height: '2px',
    backgroundColor: '#000',
    marginBottom: '0.5rem',
  } as React.CSSProperties,
};
