/**
 * Tutorials.tsx — Centro de tutoriales y guías
 */
import { useState } from 'react'
import {
  ChevronDown, ChevronRight, ExternalLink,
  CheckCircle, AlertTriangle, Info, FileText, Shield,
  Settings, Upload, Key, Globe, Terminal,
  Wallet, Smartphone, CreditCard, Zap, Lock, ArrowRight,
} from 'lucide-react'
import logoSvg from '../assets/logo.svg'

// ── Componentes de ayuda ──────────────────────────────────────────

function StepBadge({ n }: { n: number }) {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
      background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontWeight: 700, fontSize: '0.875rem',
      boxShadow: '0 2px 8px rgba(99,102,241,0.4)',
    }}>{n}</div>
  )
}

function Callout({ type, children }: { type: 'info' | 'warning' | 'success', children: React.ReactNode }) {
  const styles = {
    info:    { bg: 'rgba(99,102,241,0.08)',  border: 'rgba(99,102,241,0.3)',  color: '#818cf8', Icon: Info },
    warning: { bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.3)',  color: '#fbbf24', Icon: AlertTriangle },
    success: { bg: 'rgba(52,211,153,0.08)',  border: 'rgba(52,211,153,0.3)',  color: '#34d399', Icon: CheckCircle },
  }
  const s = styles[type]
  return (
    <div style={{
      display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: '0.75rem', padding: '0.875rem 1rem', margin: '1rem 0',
    }}>
      <s.Icon size={17} color={s.color} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}

function Screenshot({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div style={{ margin: '1.25rem 0' }}>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontStyle: 'italic' }}>
        📸 {label}
      </p>
      <div style={{
        border: '1px solid var(--border-color)', borderRadius: '0.75rem',
        overflow: 'hidden', background: 'var(--bg-card)',
        boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{
          background: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border-color)',
          padding: '0.5rem 0.875rem', display: 'flex', gap: '0.4rem', alignItems: 'center',
        }}>
          {['#ff5f57','#febc2e','#28c840'].map(c => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
          ))}
          <div style={{
            flex: 1, marginLeft: '0.5rem', background: 'var(--bg-main)',
            borderRadius: '0.375rem', padding: '0.2rem 0.75rem',
            fontSize: '0.7rem', color: 'var(--text-muted)',
          }}>
            arca.gob.ar
          </div>
        </div>
        <div style={{ padding: '1.25rem' }}>{children}</div>
      </div>
    </div>
  )
}


function LinkBtn({ href, children }: { href: string, children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
      color: '#6366f1', fontSize: '0.875rem', fontWeight: 500,
      textDecoration: 'none', borderBottom: '1px solid rgba(99,102,241,0.3)',
      paddingBottom: '1px',
    }}>
      {children} <ExternalLink size={12} />
    </a>
  )
}

// ── Tutorial ARCA ─────────────────────────────────────────────────

function TutorialARCA() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>

      {/* Introducción */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(139,92,246,0.05))',
        border: '1px solid rgba(99,102,241,0.2)', borderRadius: '1rem', padding: '1.5rem',
      }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '0.75rem', flexShrink: 0,
            background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Shield size={24} color="#6366f1" />
          </div>
          <div>
            <h3 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
              ¿Qué es ARCA?
            </h3>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
              ARCA (Agencia de Recaudación y Control Aduanero) es el organismo fiscal argentino,
              anteriormente conocido como AFIP. La integración con ARCA te permite emitir
              <strong> facturas electrónicas oficiales (CAE)</strong> directamente desde TechRepair,
              con validez legal ante la ARCA.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1.25rem' }}>
          {['Factura A, B y C electrónica','CAE automático','Validez legal','Sin papel'].map(t => (
            <span key={t} style={{
              background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: '2rem', padding: '0.25rem 0.75rem',
              fontSize: '0.775rem', color: '#818cf8', fontWeight: 500,
            }}>{t}</span>
          ))}
        </div>
      </div>

      <Callout type="warning">
        <strong>Antes de empezar:</strong> Necesitás tener tu CUIT activo en ARCA y acceso con Clave Fiscal nivel 3 o superior. Si no tenés Clave Fiscal, primero creala en <LinkBtn href="https://auth.afip.gob.ar/contribuyente_/login.xhtml">auth.afip.gob.ar</LinkBtn>
      </Callout>

      {/* PASO 1 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={1} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Ingresá al portal de ARCA con tu Clave Fiscal
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Accedé con CUIT + Clave Fiscal al portal oficial
            </p>
          </div>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7, marginLeft: '3rem' }}>
          Ingresá a <LinkBtn href="https://auth.afip.gob.ar/contribuyente_/login.xhtml">auth.afip.gob.ar</LinkBtn> con
          tu CUIT y Clave Fiscal. Si es la primera vez, vas a necesitar nivel 3 para acceder a los web services.
        </p>

        <Screenshot label="Portal de ingreso de ARCA">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 380 }}>
            <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
              <div style={{
                width: 48, height: 48, borderRadius: '0.75rem',
                background: 'linear-gradient(135deg, #0ea5e9, #0284c7)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.5rem',
              }}>
                <Shield size={24} color="#fff" />
              </div>
              <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1rem' }}>ARCA</h4>
              <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                Agencia de Recaudación y Control Aduanero
              </p>
            </div>
            {[
              { label: 'CUIT / CUIL / CDI', placeholder: '20-12345678-9', type: 'text' },
              { label: 'Clave Fiscal', placeholder: '••••••••', type: 'password' },
            ].map(f => (
              <div key={f.label}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>{f.label}</label>
                <div style={{
                  border: '1px solid var(--border-color)', borderRadius: '0.5rem',
                  padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: 'var(--text-muted)',
                  background: 'var(--bg-main)',
                }}>{f.placeholder}</div>
              </div>
            ))}
            <div style={{
              background: '#0ea5e9', borderRadius: '0.5rem', padding: '0.625rem',
              textAlign: 'center', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
            }}>Ingresar</div>
          </div>
        </Screenshot>
      </section>

      {/* PASO 2 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={2} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Accedé a "Administración de Certificados Digitales"
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Desde el menú principal → Servicios → WSASS
            </p>
          </div>
        </div>

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7, marginLeft: '3rem' }}>
          Una vez logueado, buscá el servicio <strong>"Administración de Certificados Digitales"</strong> en
          el buscador de servicios o en el menú. También podés ir directo a: <LinkBtn href="https://wsaahomo.afip.gov.ar/ws/services/LoginCms?WSDL">WSAA Homologación</LinkBtn>
        </p>

        <Screenshot label="Menú de servicios de ARCA — buscar 'Certificados'">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{
              border: '1px solid var(--border-color)', borderRadius: '0.5rem',
              padding: '0.5rem 0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem',
              background: 'var(--bg-main)',
            }}>
              <Globe size={14} color="var(--text-muted)" />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Buscar servicio...</span>
            </div>
            {[
              { name: 'Administración de Certificados Digitales', desc: 'WSASS — Gestión de certificados para web services', active: true },
              { name: 'Facturación Electrónica (WSFEV1)', desc: 'Emisión de comprobantes electrónicos', active: false },
            ].map(s => (
              <div key={s.name} style={{
                border: `1px solid ${s.active ? '#6366f1' : 'var(--border-color)'}`,
                background: s.active ? 'rgba(99,102,241,0.08)' : 'transparent',
                borderRadius: '0.5rem', padding: '0.75rem',
              }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: s.active ? '#818cf8' : 'var(--text-primary)' }}>{s.name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </Screenshot>
      </section>

      {/* PASO 3 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={3} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Generá el CSR desde TechRepair
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Con un solo click TechRepair genera la clave privada y el CSR por vos
            </p>
          </div>
        </div>

        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Andá a <strong>Configuración → ARCA / Facturación Electrónica</strong> en el sidebar.
            Asegurate de tener completos el <strong>CUIT emisor</strong> y la <strong>Razón Social</strong>.
            Luego hacé clic en el botón <strong>"Generar CSR para AFIP"</strong>.
          </p>

          <Screenshot label="Configuración → ARCA — botón Generar CSR">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 460 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.75rem', background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.5rem',
              }}>
                <Settings size={18} color="#6366f1" />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#818cf8' }}>
                  Configuración → ARCA / Facturación Electrónica
                </span>
              </div>
              <div style={{
                padding: '1rem', background: 'rgba(251,191,36,0.06)',
                border: '1px solid rgba(251,191,36,0.2)', borderRadius: '0.5rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <AlertTriangle size={14} color="#fbbf24" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fbbf24' }}>Certificado Digital</span>
                </div>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Si no tenés certificado, generá un CSR y presentalo ante AFIP para obtener el tuyo.
                </p>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.5rem 1rem',
                  background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)',
                  borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.8rem', fontWeight: 600,
                }}>
                  <FileText size={14} />
                  Generar CSR para AFIP
                </div>
              </div>
            </div>
          </Screenshot>

          <Callout type="success">
            <strong>Al hacer clic</strong>, TechRepair genera automáticamente una clave privada RSA 2048 bits,
            crea el CSR con tus datos fiscales, <strong>guarda la clave privada de forma segura en la base de datos</strong>
            y descarga el archivo <code style={{ fontFamily: 'monospace' }}>.csr</code> en tu computadora.
            No necesitás instalar nada.
          </Callout>

          <Callout type="warning">
            <strong>⚠️ Importante:</strong> Una vez que descargaste el CSR, <strong>no vuelvas a hacer clic en "Generar CSR"</strong> hasta haber completado todos los pasos siguientes (subir a AFIP, pegar el .crt y guardar). Cada vez que generás un nuevo CSR se crea una clave privada diferente, y el certificado anterior queda inválido.
          </Callout>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            {[
              { icon: Key, name: 'Clave privada', desc: 'Guardada automáticamente y encriptada en TechRepair — no la necesitás descargar', color: '#34d399' },
              { icon: FileText, name: 'archivo.csr', desc: 'Se descarga en tu PC — este es el que subís a ARCA en el paso siguiente', color: '#818cf8' },
            ].map(f => (
              <div key={f.name} style={{
                display: 'flex', gap: '0.75rem', alignItems: 'center',
                background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                borderRadius: '0.625rem', padding: '0.75rem',
              }}>
                <f.icon size={18} color={f.color} />
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{f.name}</div>
                  <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PASO 4 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={4} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Subí el CSR a ARCA y descargá el certificado
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              ARCA firma tu CSR y te entrega el certificado (.crt)
            </p>
          </div>
        </div>

        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            En "Administración de Certificados Digitales", hacé clic en <strong>"Agregar alias"</strong>,
            poné un nombre (ej: <code style={{ background: 'var(--bg-card)', padding: '0 0.3rem', borderRadius: 3 }}>techrepair</code>)
            y subí el archivo <code style={{ background: 'var(--bg-card)', padding: '0 0.3rem', borderRadius: 3 }}>techrepair.csr</code>.
          </p>

          <Screenshot label="Pantalla de 'Agregar alias' en ARCA">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 420 }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>Alias del certificado</label>
                <div style={{
                  border: '2px solid #6366f1', borderRadius: '0.5rem',
                  padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: 'var(--text-primary)',
                  background: 'var(--bg-main)',
                }}>techrepair</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>Archivo CSR</label>
                <div style={{
                  border: '2px dashed var(--border-color)', borderRadius: '0.5rem',
                  padding: '1.25rem', textAlign: 'center',
                  background: 'var(--bg-main)',
                }}>
                  <Upload size={20} color="var(--text-muted)" style={{ marginBottom: '0.5rem' }} />
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Arrastrá o seleccioná <strong>techrepair.csr</strong>
                  </div>
                </div>
              </div>
              <div style={{
                background: '#0ea5e9', borderRadius: '0.5rem', padding: '0.625rem',
                textAlign: 'center', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
              }}>Agregar certificado</div>
            </div>
          </Screenshot>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            ARCA procesa el CSR y te permite descargar el certificado firmado.
            Descargalo y guardalo como <code style={{ background: 'var(--bg-card)', padding: '0 0.3rem', borderRadius: 3 }}>techrepair.crt</code>.
          </p>
        </div>
      </section>

      {/* PASO 5 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={5} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Autorizá el alias para acceder a Facturación Electrónica
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Paso obligatorio — sin esto AFIP rechaza la conexión con "Computador no autorizado"
            </p>
          </div>
        </div>

        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Con el certificado ya descargado, volvé al portal de ARCA en{' '}
            <LinkBtn href="https://auth.afip.gob.ar/contribuyente_/login.xhtml">auth.afip.gob.ar</LinkBtn>.
            Ingresá a <strong>"Administrador de Relaciones de Clave Fiscal"</strong> (aparece en el listado de servicios).
          </p>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7, marginTop: '0.75rem' }}>
            Dentro del Administrador de Relaciones, seguí estos pasos:
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: '1rem 0 1.25rem' }}>
            {[
              { n: 1, text: 'Hacé clic en "Nueva Relación".' },
              { n: 2, text: 'En "Representante", seleccioná el alias que acabás de crear (el mismo nombre que pusiste en AFIP al subir el CSR).' },
              { n: 3, text: 'En "Servicio", buscá y seleccioná "WSFE — Factura Electrónica" (también puede aparecer como "Facturación Electrónica - WSFEv1").' },
              { n: 4, text: 'En "Representado", ingresá tu propio CUIT (el del negocio que va a facturar).' },
              { n: 5, text: 'Confirmá la relación. AFIP te va a pedir confirmar con clave fiscal.' },
            ].map(({ n, text }) => (
              <div key={n} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                <div style={{
                  minWidth: 24, height: 24, borderRadius: '50%', background: 'rgba(99,102,241,0.2)',
                  border: '1px solid rgba(99,102,241,0.5)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, color: '#818cf8', flexShrink: 0
                }}>{n}</div>
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{text}</p>
              </div>
            ))}
          </div>

          <Screenshot label="Administrador de Relaciones de Clave Fiscal — nueva relación">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 420 }}>
              {[
                { label: 'Representante (alias)', value: 'molina.jonyy2', ok: true },
                { label: 'Servicio', value: 'WSFE — Factura Electrónica', ok: true },
                { label: 'Representado (CUIT)', value: '20-37629616-5', ok: true },
              ].map(({ label, value, ok }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</label>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    border: `1px solid ${ok ? 'rgba(52,211,153,0.3)' : 'var(--border-color)'}`,
                    borderRadius: '0.4rem', padding: '0.5rem 0.75rem',
                    background: ok ? 'rgba(52,211,153,0.05)' : 'var(--bg-main)',
                  }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{value}</span>
                    {ok && <CheckCircle size={14} color="#34d399" />}
                  </div>
                </div>
              ))}
              <div style={{
                background: '#6366f1', borderRadius: '0.4rem', padding: '0.5rem',
                textAlign: 'center', color: '#fff', fontSize: '0.8rem', fontWeight: 600, marginTop: '0.25rem'
              }}>Confirmar relación</div>
            </div>
          </Screenshot>

          <Callout type="warning">
            <strong>Este paso es obligatorio y se omite fácilmente.</strong> Si no autorizás el alias para el servicio wsfe, AFIP devuelve el error <code style={{ fontFamily: 'monospace' }}>"Computador no autorizado a acceder al servicio"</code> aunque el certificado esté bien configurado. Completalo antes de probar la conexión desde TechRepair.
          </Callout>
        </div>
      </section>

      {/* PASO 6 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={6} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Subí el certificado emitido por ARCA en TechRepair
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Solo necesitás el .crt — la clave privada ya está guardada
            </p>
          </div>
        </div>

        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Volvé a <strong>Configuración → ARCA / Facturación Electrónica</strong>. Como la clave privada
            ya se guardó automáticamente en el Paso 3, <strong>solo necesitás subir el certificado .crt</strong>
            que descargaste de ARCA:
          </p>

          <Screenshot label="Configuración de ARCA — solo subir el certificado .crt">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 480 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.75rem', background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.5rem',
              }}>
                <Settings size={18} color="#6366f1" />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#818cf8' }}>
                  Configuración → ARCA / Facturación Electrónica
                </span>
              </div>

              {/* Clave privada — ya guardada */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.75rem', background: 'rgba(52,211,153,0.06)',
                border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.5rem',
              }}>
                <CheckCircle size={16} color="#34d399" />
                <div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#34d399' }}>Clave privada</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Guardada automáticamente en el Paso 3</div>
                </div>
              </div>

              {/* Certificado — a completar */}
              <div key="cert">
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' }}>
                  Certificado (.crt) <span style={{ color: '#f87171' }}>*</span>
                </label>
                <div style={{
                  border: '2px dashed rgba(99,102,241,0.4)', borderRadius: '0.5rem',
                  padding: '1.25rem', textAlign: 'center', background: 'var(--bg-main)',
                }}>
                  <Upload size={20} color="var(--text-muted)" style={{ marginBottom: '0.5rem', display: 'block', margin: '0 auto 0.5rem' }} />
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Pegá el contenido del archivo <strong style={{ fontFamily: 'monospace' }}>.crt</strong> descargado de ARCA
                  </div>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  Abrí el .crt con el Bloc de Notas, seleccioná todo (Ctrl+A) y copialo acá
                </div>
              </div>

              <div style={{
                background: '#6366f1', borderRadius: '0.5rem', padding: '0.625rem',
                textAlign: 'center', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
              }}>Guardar configuración</div>
            </div>
          </Screenshot>

          <Callout type="info">
            Para ver el contenido del certificado en Windows, abrí el archivo <code style={{ fontFamily: 'monospace' }}>.crt</code> con el <strong>Bloc de Notas</strong> (clic derecho → Abrir con → Bloc de notas), seleccioná todo y copialo.
          </Callout>
        </div>
      </section>

      {/* PASO 7 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={7} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Emití tu primera factura electrónica
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Probá la integración emitiendo un comprobante desde una orden
            </p>
          </div>
        </div>

        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Andá a cualquier <strong>Orden completada</strong> → hacé clic en <strong>"Generar comprobante"</strong> →
            elegí el tipo de factura (A, B o C según corresponda) →
            TechRepair se va a conectar automáticamente con ARCA y te va a devolver el <strong>CAE</strong> (Código de Autorización Electrónico).
          </p>

          <Screenshot label="Generación de comprobante con CAE desde una orden">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 400 }}>
              <div style={{
                background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.3)',
                borderRadius: '0.625rem', padding: '1rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <CheckCircle size={16} color="#34d399" />
                  <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#34d399' }}>CAE obtenido exitosamente</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {[
                    { label: 'Tipo', value: 'Factura B' },
                    { label: 'Número', value: '0001-00000001' },
                    { label: 'CAE', value: '74123456789012' },
                    { label: 'Vencimiento CAE', value: '26/04/2026' },
                  ].map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontFamily: r.label === 'CAE' || r.label === 'Número' ? 'monospace' : 'inherit' }}>{r.value}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div style={{
                  flex: 1, background: '#6366f1', borderRadius: '0.5rem', padding: '0.5rem',
                  textAlign: 'center', color: '#fff', fontSize: '0.8rem', fontWeight: 600,
                }}>Descargar PDF</div>
                <div style={{
                  flex: 1, background: 'transparent', border: '1px solid var(--border-color)',
                  borderRadius: '0.5rem', padding: '0.5rem',
                  textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem',
                }}>Enviar por WhatsApp</div>
              </div>
            </div>
          </Screenshot>

          <Callout type="success">
            <strong>¡Listo!</strong> Tu integración con ARCA está funcionando. A partir de ahora,
            cada factura que emitas desde TechRepair va a tener CAE válido y podrás descargarla en PDF o
            enviarla por WhatsApp directamente al cliente.
          </Callout>
        </div>
      </section>

      {/* Recursos adicionales */}
      <section style={{
        background: 'var(--bg-card)', border: '1px solid var(--border-color)',
        borderRadius: '1rem', padding: '1.5rem',
      }}>
        <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 700 }}>
          📚 Recursos útiles
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {[
            { label: 'Portal ARCA (ex AFIP)', url: 'https://www.afip.gob.ar' },
            { label: 'Login con Clave Fiscal', url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml' },
            { label: 'Manual WSAA (autenticación)', url: 'https://www.afip.gob.ar/ws/WSAA/WSAA.ObtenerCertificado.pdf' },
            { label: 'Manual WSFEV1 (factura electrónica)', url: 'https://www.afip.gob.ar/facturadecreditoelectronica/documentos/manual_wsfecm.pdf' },
            { label: 'Administración de Certificados Digitales (ARCA)', url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml' },
          ].map(r => (
            <div key={r.url} style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.625rem 0.875rem', border: '1px solid var(--border-color)',
              borderRadius: '0.625rem', background: 'var(--bg-main)',
            }}>
              <Terminal size={14} color="var(--text-muted)" />
              <LinkBtn href={r.url}>{r.label}</LinkBtn>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}

// ── (Mercado Pago tutorial — legacy, no longer in registry) ─────
// @ts-ignore — kept for reference, removed from TUTORIALS array
// eslint-disable-next-line
export function _TutorialMercadoPagoLegacy() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>

      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(0,158,227,0.12), rgba(0,188,255,0.05))',
        border: '1px solid rgba(0,158,227,0.25)', borderRadius: '1rem', padding: '1.5rem',
      }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '0.875rem', flexShrink: 0,
            background: 'linear-gradient(135deg, #009ee3, #00bcff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem',
          }}>💳</div>
          <div>
            <h3 style={{ margin: '0 0 0.5rem', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
              Cobrá con Mercado Pago desde el comprobante
            </h3>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
              Conectá tu cuenta de Mercado Pago y cobrá con <strong>QR, link de pago o terminal Point</strong>
              directamente desde cada comprobante. TechRepair calcula la comisión automáticamente
              y registra bruto, fee y neto en finanzas.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1.25rem' }}>
          {['QR Integrado','Link de pago','Terminal Point','Sin datos técnicos','Comisiones automáticas','Registro en finanzas'].map(t => (
            <span key={t} style={{
              background: 'rgba(0,158,227,0.12)', border: '1px solid rgba(0,158,227,0.25)',
              borderRadius: '2rem', padding: '0.25rem 0.75rem',
              fontSize: '0.775rem', color: '#38bdf8', fontWeight: 500,
            }}>{t}</span>
          ))}
        </div>
      </div>

      {/* Aclaración importante */}
      <Callout type="success">
        <strong>No necesitás saber programación.</strong> La conexión se hace en 3 clicks:
        entrás a Configuración → Cobros y Pagos, hacés click en "Conectar Mercado Pago",
        autorizás con tu cuenta de MP y listo. TechRepair se encarga del resto.
      </Callout>

      {/* PASO 1 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={1} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Andá a Configuración → Cobros y Pagos
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Desde el menú lateral → Configuración → pestaña "Cobros y Pagos"
            </p>
          </div>
        </div>
        <div style={{ marginLeft: '3rem' }}>
          <Screenshot label="Configuración → pestaña Cobros y Pagos">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 460 }}>
              {/* Tabs mockup */}
              <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.5rem', flexWrap: 'wrap' }}>
                {['Datos del Negocio','ARCA','Preferencias','Cobros y Pagos'].map(tab => (
                  <div key={tab} style={{
                    padding: '0.35rem 0.75rem', borderRadius: '0.375rem 0.375rem 0 0',
                    fontSize: '0.78rem', fontWeight: tab === 'Cobros y Pagos' ? 700 : 400,
                    color: tab === 'Cobros y Pagos' ? '#009ee3' : 'var(--text-muted)',
                    borderBottom: tab === 'Cobros y Pagos' ? '2px solid #009ee3' : '2px solid transparent',
                  }}>{tab}</div>
                ))}
              </div>
              {/* Content */}
              <div style={{ padding: '0.75rem', background: 'rgba(0,158,227,0.06)', border: '1px solid rgba(0,158,227,0.2)', borderRadius: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <Zap size={14} color="#fbbf24" />
                  <span style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>Mercado Pago</span>
                  <span style={{ fontSize: '0.72rem', color: '#94a3b8', background: 'rgba(255,255,255,0.06)', padding: '0.1rem 0.5rem', borderRadius: '9999px' }}>No conectado</span>
                </div>
                <div style={{
                  background: '#009ee3', borderRadius: '0.375rem', padding: '0.5rem 1rem',
                  textAlign: 'center', color: '#fff', fontSize: '0.8rem', fontWeight: 600,
                  display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
                }}>
                  <ExternalLink size={13} /> Conectar Mercado Pago
                </div>
              </div>
            </div>
          </Screenshot>
        </div>
      </section>

      {/* PASO 2 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={2} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Hacé click en "Conectar Mercado Pago"
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Se abre la pantalla oficial de autorización de MP en una nueva pestaña
            </p>
          </div>
        </div>
        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Vas a ver una pantalla oficial de Mercado Pago con el nombre de la aplicación TechRepair.
            Esta pantalla muestra <strong>exactamente qué permisos le estás dando</strong>:
          </p>

          <Screenshot label="Así va a verse la pantalla de autorización con tu logo">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 360 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                  Autoriza la integración de la aplicación
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Revisá los permisos que vas a otorgar
                </div>
              </div>
              {/* Logos con el tuyo en vez del Joker */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.875rem', padding: '0.875rem', border: '1px solid var(--border-color)', borderRadius: '0.625rem', background: 'var(--bg-main)' }}>
                <img src={logoSvg} alt="TechRepair Pro" style={{ width: '3.25rem', height: '3.25rem', borderRadius: '0.75rem' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ width: '1.25rem', height: '2px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px' }} />
                  <div style={{ width: '1.25rem', height: '2px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px' }} />
                </div>
                <div style={{ width: '3.25rem', height: '3.25rem', borderRadius: '0.75rem', background: 'linear-gradient(135deg,#009ee3,#00bcff)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem' }}>💳</div>
              </div>
              <div style={{ padding: '0.375rem 0.75rem', background: 'var(--bg-main)', border: '1px solid var(--border-color)', borderRadius: '0.375rem', textAlign: 'center' }}>
                <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-primary)' }}>TechRepair Pro</div>
              </div>
              {[
                { ok: true, text: 'Ver datos privados de tu cuenta (perfil, movimientos)' },
                { ok: true, text: 'Operar con tu cuenta (crear cobros y links de pago)' },
              ].map(p => (
                <div key={p.text} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <CheckCircle size={15} color="#34d399" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.text}</span>
                </div>
              ))}
              <div style={{ background: '#009ee3', borderRadius: '0.5rem', padding: '0.625rem', textAlign: 'center', color: '#fff', fontSize: '0.875rem', fontWeight: 700 }}>Autorizar</div>
              <div style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Por ahora no</div>
            </div>
          </Screenshot>

          <Callout type="info">
            <strong>¿Por qué pide esos permisos?</strong> TechRepair necesita crear órdenes de cobro
            (QR / links) y verificar el estado de los pagos. Nunca accede a contraseñas ni transfiere fondos.
          </Callout>
        </div>
      </section>

      {/* PASO 3 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={3} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Hacé click en "Autorizar" y volvés automáticamente
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              TechRepair guarda la conexión de forma segura — los tokens se cifran antes de guardarse
            </p>
          </div>
        </div>
        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Después de autorizar, MP te redirige de vuelta a TechRepair automáticamente.
            Vas a ver una pantalla de confirmación y en segundos estás en
            <strong> Configuración → Cobros y Pagos</strong> con el estado <strong style={{ color: '#34d399' }}>● Conectado</strong>.
          </p>

          <Screenshot label="Conexión exitosa">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 400 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '1rem', background: 'rgba(52,211,153,0.08)',
                border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.75rem',
              }}>
                <CheckCircle size={24} color="#34d399" style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700, color: '#34d399', fontSize: '0.9rem' }}>¡Mercado Pago conectado!</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    A partir de ahora podés cobrar con QR y link desde cada comprobante.
                  </div>
                </div>
              </div>
            </div>
          </Screenshot>
        </div>
      </section>

      {/* PASO 4 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={4} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Configurá tus botones de cobro
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              TechRepair crea 6 botones automáticamente — podés editarlos o crear los tuyos
            </p>
          </div>
        </div>
        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            En la sección <strong>Botones de cobro</strong> vas a encontrar los métodos predeterminados.
            Cada botón tiene configurada la <strong>comisión estimada</strong> del proveedor.
            Podés ajustar los porcentajes, agregar nuevos o desactivar los que no usás.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.625rem', margin: '1.25rem 0', maxWidth: 460 }}>
            {[
              { name: 'Efectivo',      fee: '0%',     color: '#34d399' },
              { name: 'Transferencia', fee: '0%',     color: '#60a5fa' },
              { name: 'Débito (MP)',   fee: '0.89%',  color: '#818cf8' },
              { name: 'Crédito (MP)',  fee: '3.99%',  color: '#f59e0b' },
              { name: 'QR (MP)',       fee: '0.99%',  color: '#a78bfa' },
              { name: 'Link de pago',  fee: '3.99%',  color: '#6366f1' },
            ].map(b => (
              <div key={b.name} style={{
                padding: '0.75rem',
                border: `2px solid ${b.color}33`,
                backgroundColor: `${b.color}11`,
                borderRadius: '0.625rem',
              }}>
                <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', backgroundColor: b.color, marginBottom: '0.4rem' }} />
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.2rem' }}>{b.name}</div>
                <div style={{ fontSize: '0.65rem', color: b.color }}>{b.fee}</div>
              </div>
            ))}
          </div>

          <Callout type="info">
            Las comisiones son estimadas. Los valores reales se concilian después con los reportes de liquidación de MP.
          </Callout>
        </div>
      </section>

      {/* PASO 5 */}
      <section>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
          <StepBadge n={5} />
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
              Cobrá desde el comprobante
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Abrí cualquier comprobante y usá el panel de cobros del sidebar derecho
            </p>
          </div>
        </div>
        <div style={{ marginLeft: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.7 }}>
            Desde la vista de detalle de cualquier comprobante, en el sidebar derecho vas a ver el
            <strong> Panel de Cobros</strong>. Mostrá el saldo pendiente y los botones activos de tu negocio.
          </p>

          <Screenshot label="Panel de cobros en el detalle del comprobante">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 380 }}>
              {/* Saldo */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Saldo a cobrar</span>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: '#f59e0b', fontFamily: 'monospace' }}>$15.000,00</span>
              </div>
              {/* Botones */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {[
                  { name: 'Efectivo', color: '#34d399', fee: 'Sin comisión' },
                  { name: 'QR (MP)', color: '#a78bfa', fee: '0.99%', zap: true },
                ].map(b => (
                  <div key={b.name} style={{
                    padding: '0.75rem', border: `2px solid ${b.color}44`,
                    backgroundColor: `${b.color}15`, borderRadius: '0.625rem',
                  }}>
                    <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.25rem', alignItems: 'center' }}>
                      <Wallet size={13} color={b.color} />
                      {b.zap && <Zap size={10} color="#fbbf24" />}
                    </div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{b.name}</div>
                    <div style={{ fontSize: '0.65rem', color: b.color, marginTop: '0.1rem' }}>{b.fee}</div>
                  </div>
                ))}
              </div>
              {/* Calculadora */}
              <div style={{ padding: '0.75rem', background: 'rgba(0,158,227,0.08)', border: '1px solid rgba(0,158,227,0.2)', borderRadius: '0.5rem' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#38bdf8', marginBottom: '0.5rem' }}>QR (MP) — Calculadora</div>
                {[
                  { label: 'Cobrar al cliente', val: '$15.150,75', highlight: true },
                  { label: 'Comisión MP (0.99%)', val: '−$150,75', color: '#f59e0b' },
                  { label: 'Neto a recibir', val: '$15.000,00', color: '#34d399', big: true },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: r.big ? '0.85rem' : '0.78rem', marginBottom: '0.2rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: r.big ? 700 : 500, color: r.color ?? 'var(--text-primary)' }}>{r.val}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: '#a78bfa', borderRadius: '0.5rem', padding: '0.5rem', textAlign: 'center', color: '#fff', fontSize: '0.8rem', fontWeight: 600 }}>
                Crear orden QR $15.150,75
              </div>
            </div>
          </Screenshot>
        </div>
      </section>

      {/* Calculadora — explicación */}
      <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '1rem', padding: '1.5rem' }}>
        <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 700 }}>
          🧮 Calculadora de cobro: Precio de lista vs Neto deseado
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {[
            {
              title: 'Precio de lista',
              desc: 'Cobrás exactamente el total del comprobante. TechRepair te muestra cuánto va a descontar el proveedor y cuánto vas a recibir.',
              example: 'Comprobante: $10.000\nComisión MP QR (0.99%): −$99\nNeto a recibir: $9.901',
              color: '#818cf8',
            },
            {
              title: 'Neto deseado',
              desc: 'Vos ingresás cuánto querés recibir limpio. TechRepair calcula automáticamente cuánto cobrarle al cliente para que vos recibas ese exacto.',
              example: 'Quiero recibir: $10.000\nTechRepair cobra al cliente: $10.101\nComisión: $101',
              color: '#34d399',
            },
          ].map(m => (
            <div key={m.title} style={{ padding: '1rem', background: 'var(--bg-main)', border: '1px solid var(--border-color)', borderRadius: '0.75rem' }}>
              <div style={{ fontWeight: 700, color: m.color, fontSize: '0.9rem', marginBottom: '0.5rem' }}>{m.title}</div>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 0.75rem' }}>{m.desc}</p>
              <pre style={{
                fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.03)', padding: '0.625rem', borderRadius: '0.375rem',
                margin: 0, whiteSpace: 'pre-wrap',
              }}>{m.example}</pre>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section>
        <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 700 }}>
          ❓ Preguntas frecuentes
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[
            {
              q: '¿Necesito tener una cuenta de Mercado Pago?',
              a: 'Sí, necesitás una cuenta de MP activa (puede ser personal o de empresa). Si no tenés, podés crearla en mercadopago.com.ar.',
            },
            {
              q: '¿Es seguro darle acceso a TechRepair a mi cuenta de MP?',
              a: 'Sí. TechRepair solo puede crear cobros y ver el estado de los pagos. No puede transferir dinero ni acceder a tu contraseña. Podés revocar el acceso desde tu cuenta de MP en cualquier momento.',
            },
            {
              q: '¿Las comisiones que muestra TechRepair son exactas?',
              a: 'Son estimadas. Las comisiones reales las cobra MP directamente y varían según tu plan. TechRepair las registra y cuando MP liquida, podés actualizar los valores reales.',
            },
            {
              q: '¿Puedo agregar mi posnet u otro proveedor además de MP?',
              a: 'Sí. En Configuración → Cobros y Pagos podés crear botones de cobro personalizados para cualquier proveedor (Posnet, Getnet, transferencia bancaria, etc.), con sus propias comisiones.',
            },
            {
              q: '¿Cómo desconecto Mercado Pago?',
              a: 'En Configuración → Cobros y Pagos → botón "Desconectar". Esto deshabilita los botones integrados pero conserva tu historial de cobros.',
            },
          ].map(faq => (
            <details key={faq.q} style={{ border: '1px solid var(--border-color)', borderRadius: '0.75rem', overflow: 'hidden' }}>
              <summary style={{
                padding: '0.875rem 1rem', cursor: 'pointer', fontWeight: 600,
                fontSize: '0.875rem', color: 'var(--text-primary)',
                listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                {faq.q}
                <ChevronDown size={15} color="var(--text-muted)" />
              </summary>
              <div style={{ padding: '0 1rem 0.875rem', fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6, borderTop: '1px solid var(--border-color)' }}>
                {faq.a}
              </div>
            </details>
          ))}
        </div>
      </section>

      <Callout type="success">
        <strong>¿Querés empezar ahora?</strong> Andá a{' '}
        <a href="/settings?tab=pagos" style={{ color: '#34d399', fontWeight: 700 }}>
          Configuración → Cobros y Pagos
        </a>{' '}
        y conectá tu cuenta de Mercado Pago en menos de 2 minutos.
      </Callout>

    </div>
  )
}

// ── Listado de tutoriales ─────────────────────────────────────────

const TUTORIALS = [
  {
    id: 'arca',
    title: 'Integración con ARCA (Factura Electrónica)',
    description: 'Configurá tu certificado digital y empezá a emitir facturas A, B y C con CAE válido.',
    icon: Shield,
    color: '#6366f1',
    duration: '20 min',
    level: 'Intermedio',
    component: TutorialARCA,
  },
]

// ── Página principal ──────────────────────────────────────────────

export function Tutorials() {
  const [selected, setSelected] = useState<string | null>(null)
  const tutorial = TUTORIALS.find(t => t.id === selected)

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          {selected && (
            <button
              onClick={() => setSelected(null)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.375rem',
                fontSize: '0.875rem', padding: 0,
              }}
            >
              <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
              Tutoriales
            </button>
          )}
          <h1 style={{
            margin: 0, color: 'var(--text-primary)', fontSize: '1.75rem', fontWeight: 700,
          }}>
            {selected ? tutorial?.title : 'Tutoriales'}
          </h1>
        </div>
        {!selected && (
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.95rem' }}>
            Guías paso a paso para sacarle el máximo provecho a TechRepair.
          </p>
        )}
      </div>

      {/* Lista de tutoriales */}
      {!selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {TUTORIALS.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '1.25rem',
                  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                  borderRadius: '1rem', padding: '1.25rem 1.5rem',
                  cursor: 'pointer', textAlign: 'left', width: '100%',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.borderColor = t.color
                  ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'
                  ;(e.currentTarget as HTMLElement).style.boxShadow = `0 4px 20px ${t.color}20`
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-color)'
                  ;(e.currentTarget as HTMLElement).style.transform = 'none'
                  ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
                }}
              >
                <div style={{
                  width: 52, height: 52, borderRadius: '0.875rem', flexShrink: 0,
                  background: `${t.color}18`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={26} color={t.color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '1rem', marginBottom: '0.25rem' }}>
                    {t.title}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '0.625rem' }}>
                    {t.description}
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    {[{ label: `⏱ ${t.duration}` }, { label: `📊 ${t.level}` }].map(b => (
                      <span key={b.label} style={{
                        fontSize: '0.75rem', color: 'var(--text-muted)',
                        background: 'var(--bg-main)', border: '1px solid var(--border-color)',
                        padding: '0.2rem 0.6rem', borderRadius: '0.375rem',
                      }}>{b.label}</span>
                    ))}
                  </div>
                </div>
                <ChevronDown size={18} color="var(--text-muted)" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }} />
              </button>
            )
          })}
        </div>
      )}

      {/* Tutorial seleccionado */}
      {selected && tutorial && (
        <tutorial.component />
      )}
    </div>
  )
}
