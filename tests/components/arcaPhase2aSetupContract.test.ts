/**
 * ARCA Self-Service Phase 2A — contrato del asistente en el navegador (sin UI).
 *
 *   · la pantalla se deriva SÓLO del estado canónico de Phase 1 (deriveArcaSetupWizard);
 *   · un negocio configurado (Clic) nunca ve un paso de escritura del asistente inicial;
 *   · el parser de respuestas del Edge copia sólo campos del contrato y falla cerrado.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

import type { ArcaSelfServiceStatus } from '../../src/lib/arcaStatus'
import { deriveArcaSetupWizard } from '../../src/lib/arcaSetupWizard'
import { parseArcaSetupResponse, newArcaSetupIdempotencyKey } from '../../src/services/arcaSetupService'

const base = (): ArcaSelfServiceStatus => ({
  contract_version: 1, available: true, status: 'not_configured', configured: false,
  environment: null, cuit: null, razon_social: null, punto_venta: null, alias: null,
  certificate: { present: false, expires_at: null, days_remaining: null, renewal_state: 'not_configured', matches_credential: false },
  credential: { active: false },
  connection: { state: 'unknown', last_verified_at: null },
  setup: { state: 'not_started', kind: null, step: null, started_at: null },
  attention: [], can_manage: true, next_action: 'start_setup',
})

const inProgress = (step: 'certificate' | 'verification' | 'activation', kind: 'initial' | 'renewal' = 'initial'): ArcaSelfServiceStatus => ({
  ...base(), status: 'setup_in_progress', next_action: 'continue_setup',
  setup: { state: 'in_progress', kind, step, started_at: '2026-09-13T10:00:00Z' },
})

const clic = (): ArcaSelfServiceStatus => ({
  ...base(), status: 'connected', configured: true, environment: 'produccion', cuit: '20123456783', punto_venta: 10,
  certificate: { present: true, expires_at: '2028-07-25T23:58:12Z', days_remaining: 681, renewal_state: 'healthy', matches_credential: true },
  credential: { active: true }, connection: { state: 'connected', last_verified_at: '2026-09-11T13:31:12Z' },
  setup: { state: 'completed', kind: null, step: null, started_at: null }, next_action: 'none',
})

describe('deriveArcaSetupWizard — autoridad = Phase 1', () => {
  it.each([
    ['sin configurar + gestor', base(), 'datos_fiscales', ['prepare']],
    ['esperando certificado', inProgress('certificate'), 'presentar_en_arca', ['csr', 'certificate', 'cancel']],
    ['certificado adjunto', inProgress('verification'), 'verificar_conexion', ['csr', 'certificate', 'verify', 'cancel']],
    ['verificado sin activar', inProgress('activation'), 'finalizar_activacion', ['verify', 'cancel']],
    ['Clic configurado', clic(), 'listo', []],
  ] as const)('%s → %s', (_label, status, screen, actions) => {
    const view = deriveArcaSetupWizard(status)
    expect(view.screen).toBe(screen)
    expect([...view.actions]).toEqual(actions)
  })

  it('Clic nunca recibe acciones del asistente inicial, ni siquiera con renovación viva', () => {
    expect(deriveArcaSetupWizard({ ...clic(), setup: { state: 'in_progress', kind: 'renewal', step: 'certificate', started_at: null } }).actions).toEqual([])
    expect(deriveArcaSetupWizard({ ...clic(), setup: { state: 'in_progress', kind: 'renewal', step: 'certificate', started_at: null } }).screen).toBe('fuera_de_alcance')
  })

  it('renovación en curso sin credencial activa (fila legacy) → fuera de alcance', () => {
    expect(deriveArcaSetupWizard(inProgress('certificate', 'renewal')).screen).toBe('fuera_de_alcance')
  })

  it('no gestores: solo lectura en cualquier paso', () => {
    for (const s of [base(), inProgress('certificate'), inProgress('activation')]) {
      const view = deriveArcaSetupWizard({ ...s, can_manage: false })
      expect(view.screen).toBe('solo_lectura')
      expect(view.actions).toEqual([])
    }
  })

  it('plan sin ARCA, estado ilegible o atención con material suelto → sin acciones', () => {
    expect(deriveArcaSetupWizard({ ...base(), available: false }).screen).toBe('no_disponible')
    expect(deriveArcaSetupWizard(null).screen).toBe('fuera_de_alcance')
    const loose = { ...base(), status: 'attention' as const, attention: ['credential_missing' as const],
      certificate: { ...base().certificate, present: true } }
    expect(deriveArcaSetupWizard(loose).actions).toEqual([])
  })
})

describe('parseArcaSetupResponse — fail-closed', () => {
  it('copia sólo campos del contrato', () => {
    const r = parseArcaSetupResponse({
      ok: true, state: 'SETUP_PREPARED',
      csr: { pem: '-----BEGIN CERTIFICATE REQUEST-----\nX\n-----END CERTIFICATE REQUEST-----', filename: 'techrepair-arca-20111111112.csr' },
      subject: { alias: 'a', cuit: '20111111112' }, signing_key_pem: 'NO', token: 'NO', detail: 'SQL',
    })
    expect(r).toEqual({ ok: true, state: 'SETUP_PREPARED', csr: { pem: '-----BEGIN CERTIFICATE REQUEST-----\nX\n-----END CERTIFICATE REQUEST-----', filename: 'techrepair-arca-20111111112.csr' } })
    expect(JSON.stringify(r)).not.toMatch(/signing|token|SQL/)
  })

  it.each([
    [null, { ok: false, state: 'SETUP_UNAVAILABLE' }],
    [{ ok: true, state: 'ESTADO_INVENTADO' }, { ok: false, state: 'SETUP_UNAVAILABLE' }],
    [{ ok: false, state: 'CERTIFICATE_CUIT_MISMATCH', detail: 'x' }, { ok: false, state: 'CERTIFICATE_CUIT_MISMATCH' }],
    [{ ok: false, error: 'FORBIDDEN' }, { ok: false, state: 'FORBIDDEN' }],
    [{ ok: false, state: 'WSAA_TICKET_ALREADY_ISSUED', retry_after_seconds: 43200 }, { ok: false, state: 'WSAA_TICKET_ALREADY_ISSUED', retryAfterSeconds: 43200 }],
    [{ ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2028-07-25T00:00:00Z' }, { ok: true, state: 'ACTIVATED', connection: 'connected', expiresAt: '2028-07-25T00:00:00Z' }],
    [{ ok: true, state: 'SETUP_PREPARED', csr: { pem: 'not a csr', filename: '../../etc' } }, { ok: true, state: 'SETUP_PREPARED' }],
  ])('%j', (raw, want) => {
    expect(parseArcaSetupResponse(raw)).toEqual(want)
  })

  it('claves de idempotencia estables y válidas para el backend', () => {
    const k = newArcaSetupIdempotencyKey()
    expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
    expect(newArcaSetupIdempotencyKey()).not.toBe(k)
  })
})
