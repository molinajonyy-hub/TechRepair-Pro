/**
 * ARCA Self-Service Phase 1 — contrato de UI del read model canónico.
 *
 * El estado lo deriva el servidor (get_arca_selfservice_status, probado en
 * tests/sql/arca_phase1_status.test.sql). Acá se fija que el navegador:
 *   · valida la forma y falla cerrado ante un enum o campo desconocido;
 *   · no copia claves fuera del contrato (aunque el servidor las mandara);
 *   · traduce cada estado sin inventar uno ni ofrecer acciones inexistentes;
 *   · no muestra conceptos técnicos (CSR, Vault, WSAA, fingerprints).
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import {
  describeArcaStatus, formatCuit, parseArcaSelfServiceStatus, type ArcaSelfServiceStatus,
} from '../../src/lib/arcaStatus'
import { ArcaStatusCard } from '../../src/components/settings/ArcaStatusCard'

/** Forma de la fila productiva de Clic (valores sintéticos salvo la forma). */
const connected = (): ArcaSelfServiceStatus => ({
  contract_version: 1,
  available: true,
  status: 'connected',
  configured: true,
  environment: 'produccion',
  cuit: '20123456783',
  razon_social: 'Negocio Demo',
  punto_venta: 10,
  alias: 'demo.alias',
  certificate: { present: true, expires_at: '2028-07-25T23:58:12+00:00', days_remaining: 682, renewal_state: 'healthy', matches_credential: true },
  credential: { active: true },
  connection: { state: 'connected', last_verified_at: '2026-09-11T13:31:12.597+00:00' },
  setup: { state: 'completed', kind: null, step: null, started_at: null },
  attention: [],
  can_manage: true,
  next_action: 'none',
})

const notConfigured = (canManage: boolean): ArcaSelfServiceStatus => ({
  ...connected(),
  status: 'not_configured', configured: false, environment: null, cuit: null, razon_social: null,
  punto_venta: null, alias: null,
  certificate: { present: false, expires_at: null, days_remaining: null, renewal_state: 'not_configured', matches_credential: false },
  credential: { active: false },
  connection: { state: 'unknown', last_verified_at: null },
  setup: { state: 'not_started', kind: null, step: null, started_at: null },
  can_manage: canManage,
  next_action: 'start_setup',
})

const TECHNICAL = /CSR|PKCS|Vault|WSAA|fingerprint|token|PEM|secret/i

describe('parseArcaSelfServiceStatus — fail-closed', () => {
  it('acepta el contrato válido y devuelve una copia', () => {
    const raw = connected()
    const parsed = parseArcaSelfServiceStatus(raw)
    expect(parsed).toEqual(raw)
    expect(parsed).not.toBe(raw)
  })

  it('descarta claves fuera del contrato, en la raíz y anidadas', () => {
    const raw = {
      ...connected(),
      cert_file: '-----BEGIN CERTIFICATE-----X', wsaa_token: 'T', ultimo_error: 'boom',
      certificate: { ...connected().certificate, certificate_pem: 'PEM', fingerprint: 'ab' },
      setup: { ...connected().setup, csr_pem: 'CSR' },
    }
    const parsed = parseArcaSelfServiceStatus(raw)
    expect(parsed).not.toBeNull()
    const text = JSON.stringify(parsed)
    for (const k of ['cert_file', 'wsaa_token', 'ultimo_error', 'certificate_pem', 'fingerprint', 'csr_pem']) {
      expect(text).not.toContain(k)
    }
  })

  it.each([
    ['status desconocido', { status: 'conectado' }],
    ['renewal_state desconocido', { certificate: { ...connected().certificate, renewal_state: 'soon' } }],
    ['connection libre', { connection: { state: 'Conectado', last_verified_at: null } }],
    ['setup.step desconocido', { setup: { state: 'in_progress', kind: 'renewal', step: 'upload', started_at: null } }],
    ['next_action desconocido', { next_action: 'upload_certificate' }],
    ['motivo de atención desconocido', { attention: ['boom'] }],
    ['contract_version distinto', { contract_version: 2 }],
    ['cuit con formato libre', { cuit: '20-12345678-3' }],
    ['punto de venta fuera de rango', { punto_venta: 0 }],
    ['fecha inválida', { certificate: { ...connected().certificate, expires_at: 'mañana' } }],
    ['can_manage no booleano', { can_manage: 'true' }],
  ])('%s → null', (_label, patch) => {
    expect(parseArcaSelfServiceStatus({ ...connected(), ...patch })).toBeNull()
  })

  it('no-objetos → null', () => {
    for (const raw of [null, undefined, 'connected', 1, []]) expect(parseArcaSelfServiceStatus(raw)).toBeNull()
  })
})

describe('describeArcaStatus — traducción sin derivar', () => {
  it('conectado: titular y metadata compacta', () => {
    const v = describeArcaStatus(connected())
    expect(v.headline).toBe('Conectado')
    expect(v.tone).toBe('success')
    expect(Object.fromEntries(v.rows.map((r) => [r.key, r.value]))).toMatchObject({
      cuit: '20-12345678-3', ambiente: 'Producción', 'punto-venta': '10', certificado: 'Vigente',
      vence: '25/07/2028', 'ultima-conexion': '11/09/2026',
    })
    expect(v.notices).toEqual([])
  })

  it.each([
    ['pending_verification', 'Configuración pendiente'],
    ['setup_in_progress', 'Configuración pendiente'],
    ['not_configured', 'No configurado'],
    ['attention', 'Requiere atención'],
  ] as const)('%s → %s', (status, headline) => {
    expect(describeArcaStatus({ ...connected(), status }).headline).toBe(headline)
  })

  it('por vencer: aviso informativo con los días del servidor, sin acción', () => {
    const s = { ...connected(), next_action: 'renew_certificate' as const,
      certificate: { ...connected().certificate, days_remaining: 12, renewal_state: 'urgent' as const } }
    const v = describeArcaStatus(s)
    expect(v.rows.find((r) => r.key === 'certificado')?.value).toBe('Renovación urgente')
    const notice = v.notices.find((n) => n.key === 'renewal')
    expect(notice?.text).toContain('12 días')
    expect(notice?.tone).toBe('danger')
  })

  it('renovación en curso: la conexión actual sigue y se avisa', () => {
    const v = describeArcaStatus({ ...connected(), next_action: 'continue_setup',
      setup: { state: 'in_progress', kind: 'renewal', step: 'certificate', started_at: '2026-09-12T10:00:00Z' } })
    expect(v.headline).toBe('Conectado')
    expect(v.notices.map((n) => n.key)).toEqual(['setup'])
  })

  it('atención: el primer motivo es el detalle y el resto se lista', () => {
    const v = describeArcaStatus({ ...connected(), status: 'attention', attention: ['certificate_expired', 'connection_error'] })
    expect(v.detail).toMatch(/venció/)
    expect(v.notices.map((n) => n.key)).toEqual(['connection_error'])
  })

  it('formatCuit no inventa un CUIT', () => {
    expect(formatCuit(null)).toBe('—')
    expect(formatCuit('123')).toBe('—')
  })
})

describe('ArcaStatusCard', () => {
  it('Clic: conectado, metadata y sin jerga técnica', () => {
    render(<ArcaStatusCard status={connected()} loading={false} failed={false} />)
    const card = screen.getByTestId('arca-status-card')
    expect(card.getAttribute('data-arca-status')).toBe('connected')
    expect(screen.getByTestId('arca-status-headline').textContent).toBe('Conectado')
    expect(within(screen.getByTestId('arca-status-row-punto-venta')).getByText('10')).toBeTruthy()
    expect(within(screen.getByTestId('arca-status-row-vence')).getByText('25/07/2028')).toBeTruthy()
    expect(card.textContent).not.toMatch(TECHNICAL)
    expect(card.querySelector('button')).toBeNull()
  })

  it('negocio nuevo con gestor: estado vacío deliberado, sin botón muerto ni formulario', () => {
    render(<ArcaStatusCard status={notConfigured(true)} loading={false} failed={false} />)
    const empty = screen.getByTestId('arca-status-empty')
    expect(empty.textContent).toContain('ARCA todavía no está configurado')
    expect(screen.getByTestId('arca-status-detail').textContent)
      .toBe('Conectá tu negocio con ARCA para emitir comprobantes electrónicos desde TechRepair Pro.')
    expect(screen.getByTestId('arca-status-empty-hint').textContent).toMatch(/Próximamente/)
    expect(screen.queryByTestId('arca-status-rows')).toBeNull()
    expect(document.querySelector('button, input, textarea, select')).toBeNull()
  })

  it('negocio nuevo sin gestión: sólo lectura, deriva al dueño', () => {
    render(<ArcaStatusCard status={notConfigured(false)} loading={false} failed={false} />)
    expect(screen.getByTestId('arca-status-empty-hint').textContent).toMatch(/dueño o a un administrador/)
    expect(document.querySelector('button')).toBeNull()
  })

  it('lectura fallida: no pinta un estado inventado', () => {
    render(<ArcaStatusCard status={null} loading={false} failed />)
    expect(screen.getByTestId('arca-status-error').textContent).toMatch(/No se pudo leer el estado de ARCA/)
    expect(screen.queryByTestId('arca-status-card')).toBeNull()
  })

  it('cargando', () => {
    render(<ArcaStatusCard status={null} loading failed={false} />)
    expect(screen.getByTestId('arca-status-loading')).toBeTruthy()
  })
})
