/**
 * arca-selfservice-setup — verificación NO fiscal contra WSAA (LoginCms) con el par PENDIENTE.
 *
 * Usa los helpers de `_shared/wsaaLogin.ts` (copia verbatim de afip-wsaa, fijada por guard).
 * Sólo LoginCms: nunca WSFE, FECAESolicitar ni FECompConsultar.
 *
 * Los faults reales de WSAA llegan con HTTP 500: `callWSAA` lanza "WSAA HTTP 500: <sobre SOAP>"
 * antes de cualquier parseo. La clasificación mira el faultcode dentro de ese texto contra una
 * allowlist y NUNCA devuelve, loguea ni audita el texto crudo.
 */
import { buildTRA, callWSAA, parseWSAAResponse, signTRAWithPEM } from '../_shared/wsaaLogin.ts'

export type WsaaFailureCode =
  | 'WSAA_TICKET_ALREADY_ISSUED'
  | 'WSAA_SERVICE_NOT_AUTHORIZED'
  | 'WSAA_CERTIFICATE_REJECTED'
  | 'WSAA_REJECTED'
  | 'WSAA_UNAVAILABLE'
  | 'SIGNING_FAILED'

export type WsaaLoginStage = 'signing' | 'transport' | 'http' | 'parse' | 'timeout'

export class WsaaLoginError extends Error {
  readonly stage: WsaaLoginStage
  /** Texto interno para clasificar. Jamás sale del Edge. */
  readonly detail: string
  constructor(stage: WsaaLoginStage, detail = '') {
    super(`WSAA_LOGIN_${stage.toUpperCase()}`)
    this.name = 'WsaaLoginError'
    this.stage = stage
    this.detail = detail
  }
}

export interface WsaaTicket {
  token: string
  sign: string
  expirationTime: string
}

export const WSAA_TIMEOUT_MS = 30_000

/** Clasificación acotada. El texto sólo se usa para elegir un código de la allowlist. */
export function classifyWsaaFailure(error: unknown): WsaaFailureCode {
  if (!(error instanceof WsaaLoginError)) return 'WSAA_UNAVAILABLE'
  if (error.stage === 'signing') return 'SIGNING_FAILED'
  if (error.stage === 'transport' || error.stage === 'timeout') return 'WSAA_UNAVAILABLE'
  const text = error.detail
  if (/coe\.alreadyAuthenticated|ya posee un TA/i.test(text)) return 'WSAA_TICKET_ALREADY_ISSUED'
  if (/coe\.notAuthorized|no autorizado/i.test(text)) return 'WSAA_SERVICE_NOT_AUTHORIZED'
  if (/wsn\.unavailable|wsaa\.unavailable|coe\.unavailable/i.test(text)) return 'WSAA_UNAVAILABLE'
  if (/\bcms\.|cert\.untrusted|cert\.expired|cms\.cert/i.test(text)) return 'WSAA_CERTIFICATE_REJECTED'
  if (error.stage === 'http' && !/faultcode|faultstring/i.test(text)) return 'WSAA_UNAVAILABLE'
  return 'WSAA_REJECTED'
}

/**
 * LoginCms con el certificado exacto y la clave pendiente. El ambiente selecciona el
 * endpoint (homologación / producción) igual que afip-wsaa.
 */
export async function wsaaLoginWithPendingPair(input: {
  certificatePem: string
  signingKeyPem: string
  ambiente: 'homologacion' | 'produccion'
  service: 'wsfe'
}): Promise<WsaaTicket> {
  const tra = buildTRA(input.service)
  let cms: string
  try {
    cms = signTRAWithPEM(tra, input.certificatePem, input.signingKeyPem)
  } catch {
    throw new WsaaLoginError('signing')
  }

  let reply: string
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    reply = await Promise.race([
      callWSAA(cms, input.ambiente),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WsaaLoginError('timeout')), WSAA_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    if (error instanceof WsaaLoginError) throw error
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('WSAA HTTP')) throw new WsaaLoginError('http', message)
    throw new WsaaLoginError('transport')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  try {
    return parseWSAAResponse(reply)
  } catch (error) {
    throw new WsaaLoginError('parse', error instanceof Error ? error.message : '')
  }
}
