import type { ReactNode } from 'react';
import { User, Calendar, Hash, CreditCard, FileCheck, MapPin, Mail } from 'lucide-react';

interface Cliente {
  id: string;
  name: string;
  cuit?: string;
  condicion_fiscal?: string;
  address?: string;
  email?: string;
}

interface Orden {
  id: string;
  order_number: string;
}

interface ComprobanteInfoProps {
  fecha: string;
  cliente: Cliente | null;
  orden: Orden | null;
  cae?: string | null;
  caeVencimiento?: string | null;
  condicionFiscal?: string | null;
}

function formatFecha(fechaStr: string) {
  return new Date(fechaStr).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
      <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>{icon}</span>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 500, marginLeft: 'auto' }}>{value}</span>
    </div>
  );
}

export function ComprobanteInfo({ fecha, cliente, orden, cae, caeVencimiento, condicionFiscal }: ComprobanteInfoProps) {
  const condicion = condicionFiscal || cliente?.condicion_fiscal;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'var(--bg-card)' }}>

      {/* Left — Client */}
      <div style={{ padding: '1.25rem 1.5rem', borderRight: '1px solid var(--border-subtle)' }}>
        <p style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-subtle)', marginBottom: '1rem', marginTop: 0 }}>
          Datos del cliente
        </p>

        {cliente ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {/* Avatar + name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: 'var(--accent-primary-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <User size={16} style={{ color: 'var(--accent-primary)' }} />
              </div>
              <div>
                <p style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>{cliente.name}</p>
                {cliente.cuit && (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'monospace', margin: '0.125rem 0 0' }}>
                    CUIT {cliente.cuit}
                  </p>
                )}
              </div>
            </div>

            {condicion && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CreditCard size={13} style={{ color: 'var(--text-subtle)' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Condición fiscal:</span>
                <span style={{
                  fontSize: '0.75rem', fontWeight: 600, padding: '0.125rem 0.5rem', borderRadius: 4,
                  background: 'var(--success-subtle)', color: 'var(--success)',
                }}>
                  {condicion}
                </span>
              </div>
            )}

            {cliente.address && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <MapPin size={13} style={{ color: 'var(--text-subtle)', flexShrink: 0, marginTop: 2 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{cliente.address}</span>
              </div>
            )}

            {cliente.email && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Mail size={13} style={{ color: 'var(--text-subtle)' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{cliente.email}</span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <User size={16} style={{ color: 'var(--text-subtle)' }} />
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.875rem', margin: 0 }}>Consumidor Final</p>
              <p style={{ color: 'var(--text-subtle)', fontSize: '0.75rem', margin: '0.125rem 0 0' }}>Sin datos adicionales</p>
            </div>
          </div>
        )}
      </div>

      {/* Right — Comprobante data */}
      <div style={{ padding: '1.25rem 1.5rem' }}>
        <p style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-subtle)', marginBottom: '1rem', marginTop: 0 }}>
          Datos del comprobante
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          <InfoRow
            icon={<Calendar size={13} />}
            label="Fecha de emisión"
            value={formatFecha(fecha)}
          />

          {orden && (
            <InfoRow
              icon={<Hash size={13} />}
              label="Orden relacionada"
              value={
                <span style={{ color: 'var(--accent-primary)', fontFamily: 'monospace', fontWeight: 600 }}>
                  #{orden.order_number}
                </span>
              }
            />
          )}

          {/* CAE block */}
          {cae ? (
            <div style={{
              marginTop: '0.375rem', padding: '0.75rem', borderRadius: 'var(--radius-md)',
              background: 'var(--success-subtle)', border: '1px solid var(--success)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <FileCheck size={13} style={{ color: 'var(--success)' }} />
                <span style={{ color: 'var(--success)', fontSize: '0.75rem', fontWeight: 600 }}>
                  Comprobante electrónico AFIP
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>CAE</span>
                  <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.75rem', fontWeight: 700 }}>{cae}</span>
                </div>
                {caeVencimiento && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Vencimiento</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{formatFecha(caeVencimiento)}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{
              marginTop: '0.375rem', padding: '0.625rem', borderRadius: 'var(--radius-md)',
              background: 'var(--warning-light)', border: '1px solid var(--warning)',
              textAlign: 'center',
            }}>
              <span style={{ color: 'var(--warning)', fontSize: '0.75rem' }}>
                Pendiente de emisión en AFIP
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
