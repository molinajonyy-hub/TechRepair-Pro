import React from 'react';

interface PrintServiceBlockProps {
  service: {
    reported_issue?: string;
    diagnosis?: string;
    parts_used?: string;
    labor?: string;
    observations?: string;
  };
  settings?: {
    mostrar_diagnostico?: boolean;
  };
}

export const PrintServiceBlock: React.FC<PrintServiceBlockProps> = ({ service, settings }) => {
  return (
    <div style={styles.block}>
      <h3 style={styles.blockTitle}>DETALLE DEL SERVICIO</h3>
      <div style={styles.blockContent}>
        {service.reported_issue && (
          <div style={styles.section}>
            <h4 style={styles.subTitle}>Falla Reportada:</h4>
            <p style={styles.text}>{service.reported_issue}</p>
          </div>
        )}
        {settings?.mostrar_diagnostico && service.diagnosis && (
          <div style={styles.section}>
            <h4 style={styles.subTitle}>Diagnóstico Técnico:</h4>
            <p style={styles.text}>{service.diagnosis}</p>
          </div>
        )}
        {service.parts_used && (
          <div style={styles.section}>
            <h4 style={styles.subTitle}>Repuestos Utilizados:</h4>
            <p style={styles.text}>{service.parts_used}</p>
          </div>
        )}
        {service.labor && (
          <div style={styles.section}>
            <h4 style={styles.subTitle}>Mano de Obra:</h4>
            <p style={styles.text}>{service.labor}</p>
          </div>
        )}
        {service.observations && (
          <div style={styles.section}>
            <h4 style={styles.subTitle}>Observaciones:</h4>
            <p style={styles.text}>{service.observations}</p>
          </div>
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
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  } as React.CSSProperties,
  section: {
    marginBottom: '0.5rem',
  } as React.CSSProperties,
  subTitle: {
    fontSize: '0.875rem',
    fontWeight: 'bold',
    margin: '0 0 0.5rem 0',
    color: '#333',
  } as React.CSSProperties,
  text: {
    fontSize: '0.875rem',
    margin: '0',
    color: '#000',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap' as const,
  } as React.CSSProperties,
};
