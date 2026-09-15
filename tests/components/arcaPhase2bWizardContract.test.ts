/**
 * ARCA Self-Service Phase 2B — contrato puro del asistente (sin React).
 *
 *   · entrada de la pestaña derivada sólo del estado canónico;
 *   · espera: cuenta regresiva de presentación y relectura, nunca permiso;
 *   · errores: un mapa central, sin códigos crudos ni jerga técnica;
 *   · datos fiscales: mismo CUIT/alias/PV que acepta el servidor, sin inventar valores;
 *   · certificado: un archivo con clave nunca sale del navegador;
 *   · guía: sólo datos del estado y links ya usados por el producto.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

import type { ArcaSelfServiceStatus, ArcaVerificationHold } from '../../src/lib/arcaStatus'
import { ARCA_VERIFICATION_HOLDS, describeArcaStatus } from '../../src/lib/arcaStatus'
import {
  ARCA_HOLD_REFRESH_MAX_MS, ARCA_IN_PROGRESS_POLL_MS, arcaCancelCopy, arcaHoldCountdown, arcaSetupVisibleStep,
  deriveArcaSetupEntry, deriveArcaSetupWizard, nextArcaStatusRefreshMs,
} from '../../src/lib/arcaSetupWizard'
import { ARCA_SETUP_ERROR_CODES, arcaSetupErrorForAmbiente, describeArcaSetupError } from '../../src/lib/arcaSetupErrors'
import { ARCA_SETUP_STATES } from '../../src/services/arcaSetupService'
import {
  ARCA_ALIAS_HINT, ARCA_ALIAS_PATTERNS, aliasError, checkCuit, fiscalDraftErrors, formatCuitInput, puntoVentaError, razonSocialError, suggestArcaAlias,
} from '../../src/lib/arcaFiscalInput'
import { ARCA_CERTIFICATE_MAX_BYTES, readArcaCertificateFile } from '../../src/lib/arcaCertificateFile'
import { ARCA_CLAVE_FISCAL_NOTE, buildArcaSetupGuide } from '../../src/lib/arcaSetupGuide'

const NOW = Date.parse('2026-09-14T15:00:00Z')

const base = (): ArcaSelfServiceStatus => ({
  contract_version: 1, available: true, status: 'not_configured', configured: false,
  environment: null, cuit: null, razon_social: null, punto_venta: null, alias: null,
  certificate: { present: false, expires_at: null, days_remaining: null, renewal_state: 'not_configured', matches_credential: false },
  credential: { active: false },
  connection: { state: 'unknown', last_verified_at: null },
  setup: { state: 'not_started', kind: null, step: null, started_at: null, verification_hold: null, retry_not_before: null },
  attention: [], can_manage: true, next_action: 'start_setup',
})

const inProgress = (step: 'certificate' | 'verification' | 'activation', hold: ArcaVerificationHold | null = null,
  retryNotBefore = '2026-09-14T15:10:00Z'): ArcaSelfServiceStatus => ({
  ...base(), status: 'setup_in_progress', next_action: 'continue_setup',
  environment: 'homologacion', cuit: '20123456786', razon_social: 'QA Demo', punto_venta: 3, alias: 'techrepairqa',
  setup: { state: 'in_progress', kind: 'initial', step, started_at: '2026-09-14T14:00:00Z',
    verification_hold: hold, retry_not_before: hold === null ? null : retryNotBefore },
})

const connected = (): ArcaSelfServiceStatus => ({
  ...base(), status: 'connected', configured: true, environment: 'produccion', cuit: '20123456786', punto_venta: 10,
  certificate: { present: true, expires_at: '2028-07-25T23:58:12Z', days_remaining: 681, renewal_state: 'healthy', matches_credential: true },
  credential: { active: true }, connection: { state: 'connected', last_verified_at: '2026-09-11T13:31:12Z' },
  setup: { state: 'completed', kind: null, step: null, started_at: null, verification_hold: null, retry_not_before: null }, next_action: 'none',
})

const TECHNICAL = /WSAA|LoginCms|SOAP|token|sign\b|fingerprint|Vault|secret|stack|RPC|PKCS|CSR|faultcode|coe\./i

describe('deriveArcaSetupEntry — la pestaña ARCA sale del estado canónico', () => {
  it.each([
    ['cargando', null, { loading: true, failed: false }, 'loading', null],
    ['lectura fallida', null, { loading: false, failed: true }, 'unreadable', null],
    ['sin plan', { ...base(), available: false }, { loading: false, failed: false }, 'unavailable', null],
    ['sin permiso', { ...base(), can_manage: false }, { loading: false, failed: false }, 'read_only', null],
    ['sin configurar', base(), { loading: false, failed: false }, 'start', 'Conectar ARCA'],
    ['esperando certificado', inProgress('certificate'), { loading: false, failed: false }, 'resume', 'Continuar configuración'],
    ['con espera', inProgress('verification', 'result_unknown'), { loading: false, failed: false }, 'resume', 'Continuar configuración'],
    ['verificado sin activar', inProgress('activation'), { loading: false, failed: false }, 'resume', 'Continuar configuración'],
    ['conectado', connected(), { loading: false, failed: false }, 'connected', null],
    ['atención', { ...connected(), status: 'attention' as const, attention: ['connection_error' as const], next_action: 'verify_connection' as const }, { loading: false, failed: false }, 'status_only', null],
  ] as const)('%s → %s', (_label, status, read, kind, cta) => {
    const entry = deriveArcaSetupEntry(status as ArcaSelfServiceStatus | null, read)
    expect(entry.kind).toBe(kind)
    expect(entry.cta).toBe(cta)
  })

  it('una espera nunca ofrece verificar, sea cual sea el motivo', () => {
    for (const hold of ARCA_VERIFICATION_HOLDS) {
      for (const step of ['certificate', 'verification'] as const) {
        expect(deriveArcaSetupWizard(inProgress(step, hold)).actions).not.toContain('verify')
      }
    }
  })
})

describe('espera: presentación y relectura', () => {
  it('cuenta regresiva legible y en hora de Argentina', () => {
    expect(arcaHoldCountdown('2026-09-14T15:00:45Z', NOW)).toMatchObject({ remainingSeconds: 45, remainingLabel: '45 s' })
    expect(arcaHoldCountdown('2026-09-14T15:03:00Z', NOW).remainingLabel).toBe('3 min')
    expect(arcaHoldCountdown('2026-09-15T03:05:00Z', NOW)).toMatchObject({ remainingLabel: '12 h 5 min', untilLabel: '15/09 00:05' })
    expect(arcaHoldCountdown('2026-09-14T17:00:00Z', NOW).untilLabel).toBe('14:00')
    expect(arcaHoldCountdown('2026-09-14T14:00:00Z', NOW)).toMatchObject({ remainingSeconds: 0, remainingLabel: 'unos segundos' })
    expect(arcaHoldCountdown('no-es-fecha', NOW)).toMatchObject({ remainingSeconds: 0, untilLabel: '—' })
  })

  it('relee al vencer retry_not_before (con margen), seguido si hay un intento en vuelo y nunca sin espera', () => {
    expect(nextArcaStatusRefreshMs(base(), NOW)).toBeNull()
    expect(nextArcaStatusRefreshMs(null, NOW)).toBeNull()
    expect(nextArcaStatusRefreshMs(inProgress('verification', 'in_progress'), NOW)).toBe(ARCA_IN_PROGRESS_POLL_MS)
    expect(nextArcaStatusRefreshMs(inProgress('verification', 'cooldown', '2026-09-14T15:01:00Z'), NOW)).toBe(62_000)
    expect(nextArcaStatusRefreshMs(inProgress('verification', 'ticket_active', '2026-09-15T03:00:00Z'), NOW)).toBe(ARCA_HOLD_REFRESH_MAX_MS)
    // Ya vencida: relectura inmediata acotada, nunca negativa.
    expect(nextArcaStatusRefreshMs(inProgress('verification', 'result_unknown', '2026-09-14T14:00:00Z'), NOW)).toBe(1_000)
  })

  it('paso visible: la guía y la carga del certificado son 3 y 4', () => {
    const view = deriveArcaSetupWizard(inProgress('certificate'))
    expect(arcaSetupVisibleStep(view, 'present')).toBe(3)
    expect(arcaSetupVisibleStep(view, 'upload')).toBe(4)
    expect(arcaSetupVisibleStep(deriveArcaSetupWizard(inProgress('verification')), 'present')).toBe(5)
    expect(arcaSetupVisibleStep(deriveArcaSetupWizard(connected()), 'present')).toBe(6)
  })
})

describe('confirmación de cancelar: honesta según el riesgo', () => {
  it.each(['result_unknown', 'ticket_active', 'verification_expired'] as const)('espera %s → advertencia fuerte, sin prometer revocar', (hold) => {
    const copy = arcaCancelCopy(deriveArcaSetupWizard(inProgress('verification', hold)))
    expect(copy.strong).toBe(true)
    expect(copy.message).toMatch(/no revoca nada en ARCA/)
    expect(copy.message).toMatch(/la espera se mantiene/)
  })

  it('verificado sin activar → descarta un acceso vigente', () => {
    const copy = arcaCancelCopy(deriveArcaSetupWizard(inProgress('activation')))
    expect(copy.strong).toBe(true)
    expect(copy.message).toMatch(/ARCA ya habilitó el acceso/)
  })

  it('sin espera → confirmación simple', () => {
    const copy = arcaCancelCopy(deriveArcaSetupWizard(inProgress('certificate')))
    expect(copy.strong).toBe(false)
    expect(copy.message).not.toMatch(TECHNICAL)
  })
})

describe('describeArcaSetupError — capa central', () => {
  const SUCCESS = new Set(['SETUP_PREPARED', 'SETUP_ALREADY_PREPARED', 'CSR_AVAILABLE', 'CERTIFICATE_ATTACHED', 'CERTIFICATE_ALREADY_ATTACHED',
    'CERTIFICATE_REPLACED', 'ACTIVATED', 'ALREADY_ACTIVATED', 'SETUP_CANCELLED'])

  it('cada estado de falla del backend tiene un texto propio', () => {
    for (const state of ARCA_SETUP_STATES) {
      if (SUCCESS.has(state)) continue
      expect(ARCA_SETUP_ERROR_CODES, state).toContain(state)
    }
  })

  it('ningún texto muestra jerga técnica ni el código crudo', () => {
    for (const code of ARCA_SETUP_ERROR_CODES) {
      const v = describeArcaSetupError(code)
      for (const text of [v.title, v.message, v.action]) {
        expect(text, code).not.toMatch(TECHNICAL)
        expect(text, code).not.toContain(code)
      }
    }
  })

  it('desconocido o inyectado → mensaje genérico seguro', () => {
    for (const raw of ['<soap:Fault>coe.alreadyAuthenticated</soap:Fault>', 'TypeError: x is undefined', '', null, undefined, '__proto__', 'toString']) {
      const v = describeArcaSetupError(raw as string)
      expect(v.code).toBe('SETUP_UNAVAILABLE')
      expect(v.title).toBe('No pudimos completar el paso')
    }
  })

  it('categorías: esperas y ambigüedad nunca permiten reintentar desde la UI', () => {
    for (const code of ['VERIFICATION_IN_PROGRESS', 'WSAA_RESULT_UNKNOWN', 'WSAA_TICKET_ALREADY_ISSUED', 'VERIFICATION_EXPIRED', 'VERIFICATION_COOLDOWN']) {
      expect(describeArcaSetupError(code).retry, code).toBe('after_hold')
    }
    expect(describeArcaSetupError('WSAA_RESULT_UNKNOWN').category).toBe('ambiguous')
    expect(describeArcaSetupError('INVALID_CUIT')).toMatchObject({ category: 'input', field: 'cuit', retry: 'after_fix' })
    expect(describeArcaSetupError('CERTIFICATE_KEY_MISMATCH')).toMatchObject({ category: 'certificate', field: 'certificate' })
    expect(describeArcaSetupError('WSAA_SERVICE_NOT_AUTHORIZED').category).toBe('arca')
    expect(describeArcaSetupError('ACTIVATION_PENDING').category).toBe('activation')
    expect(describeArcaSetupError('FORBIDDEN').category).toBe('auth')
    expect(describeArcaSetupError('ARCA_FEATURE_REQUIRED').category).toBe('plan')
    expect(describeArcaSetupError('SETUP_UNAVAILABLE').category).toBe('network')
  })
})

describe('datos fiscales — espejo de UX del servidor', () => {
  it('formato progresivo del CUIT', () => {
    expect(formatCuitInput('2')).toBe('2')
    expect(formatCuitInput('201234')).toBe('20-1234')
    expect(formatCuitInput('20-12345678-6')).toBe('20-12345678-6')
    expect(formatCuitInput('2012345678699999')).toBe('20-12345678-6')
  })

  it('dígito verificador módulo 11 (incluye el caso 11 → 0 y el 10 inválido)', () => {
    expect(checkCuit('20-12345678-6')).toBe('valid')
    expect(checkCuit('20-12345678-3')).toBe('invalid_check_digit')
    expect(checkCuit('')).toBe('empty')
    expect(checkCuit('2012')).toBe('incomplete')
    expect(checkCuit('11-12345678-6')).toBe('invalid_prefix')
    // Busca un CUIT cuyo resultado sea 11 (dígito 0) y otro cuyo resultado sea 10 (inválido siempre).
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
    const raw = (d: string) => 11 - ([...d].reduce((s, c, i) => s + Number(c) * weights[i], 0) % 11)
    let eleven = '', ten = ''
    for (let n = 0; n < 100_000 && (!eleven || !ten); n++) {
      const body = `20${String(n).padStart(8, '0')}`
      if (!eleven && raw(body) === 11) eleven = body
      if (!ten && raw(body) === 10) ten = body
    }
    expect(checkCuit(`${eleven}0`)).toBe('valid')
    for (let d = 0; d <= 9; d++) expect(checkCuit(`${ten}${d}`)).toBe('invalid_check_digit')
  })

  it('punto de venta y razón social con los límites del servidor', () => {
    expect(puntoVentaError('0')).toMatch(/entre 1 y 99998/)
    expect(puntoVentaError('99999')).toMatch(/entre 1 y 99998/)
    expect(puntoVentaError('2.5')).toMatch(/entero/)
    expect(puntoVentaError('3')).toBeNull()
    expect(razonSocialError('  ')).toMatch(/razón social/)
    expect(razonSocialError('x'.repeat(201))).toMatch(/200/)
  })

  it('el ambiente hay que elegirlo explícitamente', () => {
    const errors = fiscalDraftErrors({ cuit: '20-12345678-6', razonSocial: 'Demo', ambiente: '', puntoVenta: '2', alias: 'techrepairdemo' })
    expect(Object.keys(errors)).toEqual(['ambiente'])
  })
})

// Smoke real 2026-09-15: WSASS de homologación sólo acepta letras y números en el nombre del
// equipo y lo escribe en el certificado. Producción conserva la regla anterior.
describe('nombre del equipo por ambiente — espejo de prepare_initial', () => {
  const HOMOLOGACION_MESSAGE = 'En homologación ARCA acepta únicamente letras y números. Usá entre 3 y 50 caracteres.'

  it('homologación: sólo letras y números de 3 a 50', () => {
    for (const ok of ['abc', 'techrepair', 'techrepairdemohomo', 'Demo2026', '123', 'a'.repeat(50), '  techrepair  ']) {
      expect(aliasError(ok, 'homologacion'), ok).toBeNull()
    }
    for (const bad of ['ab', 'a'.repeat(51), 'techrepair-demo', 'techrepair.demo', 'techrepair_demo', 'techrepair demo',
      'técnico', 'ñandu', 'demo/arca', 'demo@arca', 'tech\trepair', 'ｔｅｃｈ']) {
      expect(aliasError(bad, 'homologacion'), bad).toBe(HOMOLOGACION_MESSAGE)
    }
    expect(aliasError('', 'homologacion')).toMatch(/Ingresá un nombre/)
  })

  it('producción: se conserva el contrato anterior (punto y guion siguen valiendo)', () => {
    expect(aliasError('techrepair-demo', 'produccion')).toBeNull()
    expect(aliasError('demo.local2', 'produccion')).toBeNull()
    expect(aliasError('techrepairdemohomo', 'produccion')).toBeNull()
    expect(aliasError('ab', 'produccion')).toMatch(/entre 3 y 50/)
    expect(aliasError('-demo', 'produccion')).toMatch(/empezando/)
    expect(aliasError('demo ñandú', 'produccion')).toMatch(/sin acentos/)
    expect(aliasError('qa_initial', 'produccion')).toMatch(/sin acentos/)
  })

  it('las regex por ambiente coinciden con las del servidor en un corpus', () => {
    const legacy = /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/
    const strict = /^[A-Za-z0-9]{3,50}$/
    const corpus = ['abc', 'ab', 'a.b', 'a-b', 'a_b', 'a b', '.ab', '-ab', 'ab.', 'ab-', 'Ab1', 'ÁBC', 'x/y', 'a'.repeat(50), 'a'.repeat(51), `a${'.'.repeat(49)}`]
    for (const s of corpus) {
      expect(ARCA_ALIAS_PATTERNS.homologacion.test(s), s).toBe(strict.test(s))
      expect(ARCA_ALIAS_PATTERNS.produccion.test(s), s).toBe(legacy.test(s))
    }
  })

  it('cambiar de producción a homologación invalida un nombre con punto o guion', () => {
    const draft = { cuit: '20-12345678-6', razonSocial: 'Demo', ambiente: 'produccion' as const, puntoVenta: '2', alias: 'techrepair-demo' }
    expect(fiscalDraftErrors(draft).alias).toBeUndefined()
    expect(fiscalDraftErrors({ ...draft, ambiente: 'homologacion' }).alias).toBe(HOMOLOGACION_MESSAGE)
    expect(fiscalDraftErrors({ ...draft, ambiente: 'homologacion', alias: 'techrepairdemo' }).alias).toBeUndefined()
  })

  it('la sugerencia automática sirve en homologación: minúsculas sin acentos y números, 3 a 50', () => {
    expect(suggestArcaAlias('Clic.')).toBe('techrepairclic')
    expect(suggestArcaAlias('Demo Local Pro')).toBe('techrepairdemolocalpro')
    expect(suggestArcaAlias('Técnico Ñandú & Cía.')).toBe('techrepairtecniconanducia')
    expect(suggestArcaAlias('', '20-30123456-7')).toBe('techrepair20301234567')
    expect(suggestArcaAlias(null, null)).toBe('techrepair')
    expect(suggestArcaAlias('x'.repeat(80))).toHaveLength(50)
    for (const name of ['Clic.', 'Técnico Ñandú & Cía.', '', 'x'.repeat(80), '---', '日本', 'A.B-C_D E', 'Taller "El Rayo" 24/7']) {
      const s = suggestArcaAlias(name)
      expect(s, name).not.toMatch(/[.\-_\s]/)
      expect(aliasError(s, 'homologacion'), name).toBeNull()
      expect(aliasError(s, 'produccion'), name).toBeNull()
    }
  })

  it('la ayuda del campo explica la regla sin hablar de regex ni de CN', () => {
    expect(ARCA_ALIAS_HINT).toBe('ARCA usa este nombre dentro del certificado. En homologación sólo puede contener letras y números.')
    expect(ARCA_ALIAS_HINT).not.toMatch(/regex|\bCN\b|DER|subject/i)
  })
})

describe('CERTIFICATE_ALIAS_MISMATCH e INVALID_ALIAS — mensajes accionables', () => {
  it('el nombre del certificado: explica y dice cómo generarlo, sin afirmar la regla de homologación en producción', () => {
    const base = describeArcaSetupError('CERTIFICATE_ALIAS_MISMATCH')
    expect(base.message).toBe('El nombre del certificado no coincide con el nombre del equipo configurado.')
    expect(base.action).toBe('Generá el certificado usando exactamente el nombre que muestra TechRepair Pro.')
    expect(arcaSetupErrorForAmbiente(base, 'produccion')).toEqual(base)
    expect(arcaSetupErrorForAmbiente(base, null)).toEqual(base)
    const homo = arcaSetupErrorForAmbiente(base, 'homologacion')
    expect(homo.message).toBe('El nombre del certificado no coincide con el nombre del equipo configurado. En homologación, ARCA acepta sólo letras y números.')
    for (const v of [base, homo]) {
      expect(`${v.title} ${v.message} ${v.action}`).not.toMatch(/\bCN\b|DER|subject|SOAP|CERTIFICATE_ALIAS_MISMATCH/)
    }
  })

  it('el alias rechazado por el servidor también suma el detalle de homologación', () => {
    const base = describeArcaSetupError('INVALID_ALIAS')
    expect(arcaSetupErrorForAmbiente(base, 'homologacion').message).toMatch(/En homologación ARCA acepta únicamente letras y números/)
    expect(arcaSetupErrorForAmbiente(base, 'produccion').message).not.toMatch(/letras y números/)
  })

  it('el detalle nunca se agrega a otros códigos ni muestra el código', () => {
    for (const code of ARCA_SETUP_ERROR_CODES) {
      if (code === 'CERTIFICATE_ALIAS_MISMATCH' || code === 'INVALID_ALIAS') continue
      expect(arcaSetupErrorForAmbiente(describeArcaSetupError(code), 'homologacion'), code).toEqual(describeArcaSetupError(code))
    }
  })
})

describe('readArcaCertificateFile — un archivo con clave nunca sale del navegador', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, bytes })
  const certPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
  const keyLabel = ['PRIVATE', 'KEY'].join(' ')
  const keyPem = `-----BEGIN ${keyLabel}-----\nMIIE\n-----END ${keyLabel}-----\n`

  it('PEM de certificado → se envía como texto', () => {
    expect(readArcaCertificateFile(file('arca.crt', enc(certPem)))).toEqual({ ok: true, kind: 'pem', pem: certPem.trim() })
  })

  it('bloques de clave (sueltos o junto al certificado) → rechazados localmente', () => {
    expect(readArcaCertificateFile(file('arca.pem', enc(keyPem)))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
    expect(readArcaCertificateFile(file('arca.pem', enc(certPem + keyPem)))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
    expect(readArcaCertificateFile(file('arca.crt', enc(keyPem.replaceAll(keyLabel, `RSA ${keyLabel}`))))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
    expect(readArcaCertificateFile(file('store.pfx', new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03])))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
    expect(readArcaCertificateFile(file('clave.key', enc('x')))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
  })

  it('DER: X.509 se envía en base64; un contenedor con versión (PKCS#12/#8) no', () => {
    const cert = new Uint8Array([0x30, 0x82, 0x00, 0x08, 0x30, 0x82, 0x00, 0x04, 0xa0, 0x03, 0x02, 0x01])
    expect(readArcaCertificateFile(file('arca.der', cert))).toEqual({ ok: true, kind: 'der', derBase64: btoa(String.fromCharCode(...cert)) })
    expect(readArcaCertificateFile(file('arca.cer', new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])))).toEqual({ ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' })
    expect(readArcaCertificateFile(file('arca.cer', new Uint8Array([0x04, 0x03, 0x02])))).toEqual({ ok: false, reason: 'CERTIFICATE_INVALID' })
  })

  it('el archivo para ARCA, formatos y tamaños no admitidos', () => {
    expect(readArcaCertificateFile(file('techrepair.csr', enc('x')))).toEqual({ ok: false, reason: 'REQUEST_FILE_NOT_CERTIFICATE' })
    expect(readArcaCertificateFile(file('arca.pem', enc('-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----')))).toEqual({ ok: false, reason: 'REQUEST_FILE_NOT_CERTIFICATE' })
    expect(readArcaCertificateFile(file('arca.pem', enc(certPem + certPem)))).toEqual({ ok: false, reason: 'CERTIFICATE_INVALID' })
    expect(readArcaCertificateFile(file('arca.txt', enc(certPem)))).toEqual({ ok: false, reason: 'UNSUPPORTED_FILE' })
    expect(readArcaCertificateFile(file('arca.crt', new Uint8Array()))).toEqual({ ok: false, reason: 'EMPTY_FILE' })
    expect(readArcaCertificateFile(file('arca.crt', new Uint8Array(ARCA_CERTIFICATE_MAX_BYTES + 1)))).toEqual({ ok: false, reason: 'TOO_LARGE' })
  })
})

describe('buildArcaSetupGuide — sin pasos ni datos inventados', () => {
  it('usa sólo lo que vino del estado y un único link oficial ya usado por el producto', () => {
    for (const ambiente of ['produccion', 'homologacion', null] as const) {
      const guide = buildArcaSetupGuide({ ambiente, alias: 'techrepairqa', cuitLabel: '20-12345678-6', filename: null })
      expect(guide.steps.length).toBeGreaterThanOrEqual(3)
      expect(guide.links.map((l) => new URL(l.href).host)).toEqual(['auth.afip.gob.ar'])
      expect(JSON.stringify(guide)).not.toMatch(TECHNICAL)
      expect(guide.steps.some((s) => s.copyValue?.value === 'techrepairqa')).toBe(true)
    }
    const empty = buildArcaSetupGuide({ ambiente: 'produccion', alias: null, cuitLabel: '—', filename: null })
    expect(empty.steps.every((s) => s.copyValue === undefined)).toBe(true)
  })

  it('homologación se identifica como ambiente de pruebas', () => {
    expect(buildArcaSetupGuide({ ambiente: 'homologacion', alias: 'abc', cuitLabel: 'x', filename: null }).intro).toMatch(/pruebas/)
  })

  it('homologación: lo aprendido en el smoke real con WSASS', () => {
    const guide = buildArcaSetupGuide({ ambiente: 'homologacion', alias: 'techrepairdemohomo', cuitLabel: '20-12345678-6', filename: null })
    const text = JSON.stringify(guide)
    const certificate = guide.steps.find((s) => s.key === 'certificate')!
    const authorize = guide.steps.find((s) => s.key === 'authorize')!
    // A. letras y números; B. el mismo nombre que muestra TechRepair Pro.
    expect(certificate.detail).toMatch(/sólo lleva letras y números/)
    expect(certificate.detail).toMatch(/exactamente el mismo nombre de equipo que muestra TechRepair Pro/)
    expect(certificate.copyValue).toEqual({ label: 'Nombre del equipo', value: 'techrepairdemohomo' })
    // C. primera vez: flujo normal. D. DN existente: agregar certificado.
    expect(certificate.detail).toMatch(/primera vez/)
    expect(certificate.note).toMatch(/«agregar certificado a DN existente»/)
    // La autorización WSFE del DN se conserva; no se pide crearla otra vez.
    expect(authorize.note).toBe('Si el DN ya tenía autorizado WSFE, esa autorización se conserva: no hace falta crearla otra vez.')
    expect(text).not.toMatch(/volv[eé] a autorizar|autoriz[aá] de nuevo/i)
  })

  it('producción no cambia: sin la regla de homologación ni pasos de WSASS', () => {
    const text = JSON.stringify(buildArcaSetupGuide({ ambiente: 'produccion', alias: 'techrepair-demo', cuitLabel: 'x', filename: null }))
    expect(text).not.toMatch(/letras y números|WSASS|DN existente/)
    expect(text).toMatch(/Administración de Certificados Digitales/)
  })
})

/** Promesas de emisión que Phase 2B NO verifica (no emite, no pide CAE, no llama FECAESolicitar). */
const EMISSION_PROMISE = /(ya )?pod[eé]s (emitir|facturar)|emitir (ya|ahora)|\bCAE\b|emisi[oó]n (real|probada|verificada)|comprobante (emitido|autorizado)|factur[aá] ya/i

describe('copy honesto — Clave Fiscal y alcance de la verificación', () => {
  it('la guía aclara que la Clave Fiscal se usa en ARCA y que TechRepair Pro nunca la pide ni la guarda', () => {
    expect(ARCA_CLAVE_FISCAL_NOTE).toMatch(/sitio de ARCA/)
    expect(ARCA_CLAVE_FISCAL_NOTE).toMatch(/nunca te pide ni guarda tu Clave Fiscal/)
    for (const ambiente of ['produccion', 'homologacion', null] as const) {
      expect(buildArcaSetupGuide({ ambiente, alias: 'a-b-c', cuitLabel: 'x', filename: null }).claveFiscalNote).toBe(ARCA_CLAVE_FISCAL_NOTE)
    }
  })

  it('"conectado" describe la conexión configurada, no una emisión probada', () => {
    const detail = describeArcaStatus(connected()).detail
    expect(detail).toMatch(/conexión con ARCA está configurada/)
    expect(detail).not.toMatch(EMISSION_PROMISE)
  })

  it('ningún mensaje del asistente promete emisión', () => {
    for (const code of ARCA_SETUP_ERROR_CODES) {
      const v = describeArcaSetupError(code)
      expect(`${v.title} ${v.message} ${v.action}`, code).not.toMatch(EMISSION_PROMISE)
    }
    for (const ambiente of ['produccion', 'homologacion'] as const) {
      expect(JSON.stringify(buildArcaSetupGuide({ ambiente, alias: 'a-b-c', cuitLabel: 'x', filename: null }))).not.toMatch(EMISSION_PROMISE)
    }
  })
})
