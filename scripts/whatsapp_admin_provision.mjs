#!/usr/bin/env node
/**
 * Operator-only script: controlled WhatsApp Cloud API provisioning / revocation.
 *
 *   node scripts/whatsapp_admin_provision.mjs provision
 *   node scripts/whatsapp_admin_provision.mjs revoke
 *
 * SECURITY MODEL
 *   - Runs in a PRIVATE backend shell, never the browser.
 *   - Uses the service_role key (the only role allowed to call the admin RPCs).
 *   - The Meta ACCESS TOKEN is read ONLY from a hidden interactive prompt:
 *       - never passed as a process argument (not in argv / shell history),
 *       - never read from a file,
 *       - never printed, logged, or echoed,
 *       - sent only inside the TLS request body as a bound RPC parameter
 *         (parameterized -- no SQL string concatenation),
 *       - stored only in Vault by the RPC; best-effort cleared after use.
 *   - Non-secret identifiers (business_id, phone_number_id, waba_id, reason, ...)
 *     come from env vars or a normal prompt.
 *
 * REQUIRED ENV (set transiently in your private shell; never commit):
 *   SUPABASE_URL                 e.g. https://vrdxxmjzxhfgqlnxmbwx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role key (secret)
 *
 * OPTIONAL ENV for non-secret fields (else you'll be prompted):
 *   WA_BUSINESS_ID, WA_PHONE_NUMBER_ID, WA_WABA_ID, WA_SYSTEM_USER_ID,
 *   WA_BUSINESS_PHONE, WA_TOKEN_EXPIRES_AT (ISO8601), WA_REASON
 *
 * This script performs a PRODUCTION write only when YOU run it after approval.
 */
import { createClient } from '@supabase/supabase-js'
import { createInterface } from 'node:readline'

// Control characters as escapes only (keeps the source plain-ASCII).
const ENTER_LF = '\n', ENTER_CR = '\r', CTRL_D = String.fromCharCode(4)
const CTRL_C = String.fromCharCode(3), DEL = String.fromCharCode(127), BS = '\b'

function fail(msg) { console.error(`x ${msg}`); process.exit(1) }

function promptVisible(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(query, (a) => { rl.close(); resolve(a.trim()) }))
}

/** Read a line WITHOUT echoing it (for the access token only). */
function promptHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write(query)
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (chunk) => {
      const s = chunk.toString('utf8')
      for (const c of s) {
        if (c === ENTER_LF || c === ENTER_CR || c === CTRL_D) {
          if (stdin.isTTY) stdin.setRawMode(wasRaw)
          stdin.pause(); stdin.removeListener('data', onData); stdout.write('\n')
          return resolve(buf)
        } else if (c === CTRL_C) {
          if (stdin.isTTY) stdin.setRawMode(wasRaw); stdout.write('\n'); process.exit(130)
        } else if (c === DEL || c === BS) {
          buf = buf.slice(0, -1)
        } else if (c >= ' ') {
          buf += c
        }
      }
    }
    stdin.on('data', onData)
  })
}

async function field(envKey, label, { required = true } = {}) {
  const fromEnv = process.env[envKey]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const v = await promptVisible(`${label}: `)
  if (required && !v) fail(`${label} es obligatorio`)
  return v || null
}

const command = (process.argv[2] || '').toLowerCase()
if (!['provision', 'revoke'].includes(command)) {
  fail('Uso: node scripts/whatsapp_admin_provision.mjs <provision|revoke>')
}

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url) fail('Falta SUPABASE_URL en el entorno.')
if (!serviceKey) fail('Falta SUPABASE_SERVICE_ROLE_KEY en el entorno (debe ser service_role).')

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

let token = null
try {
  if (command === 'revoke') {
    const business_id = await field('WA_BUSINESS_ID', 'business_id')
    const reason = await field('WA_REASON', 'reason (motivo de auditoria)')
    const { data, error } = await supabase.rpc('whatsapp_admin_revoke_connection', {
      p_business_id: business_id,
      p_reason: reason,
    })
    if (error) fail(`revoke fallo: ${error.message}`)
    console.log('OK revoke:', JSON.stringify(data))  // no secrets in the response
    process.exit(0)
  }

  // provision
  const business_id      = await field('WA_BUSINESS_ID', 'business_id')
  const phone_number_id  = await field('WA_PHONE_NUMBER_ID', 'phone_number_id')
  const waba_id          = await field('WA_WABA_ID', 'waba_id')
  const reason           = await field('WA_REASON', 'reason (motivo de auditoria)')
  const system_user_id   = await field('WA_SYSTEM_USER_ID', 'system_user_id (opcional)', { required: false })
  const business_phone   = await field('WA_BUSINESS_PHONE', 'business_phone_number (opcional)', { required: false })
  const token_expires_at = await field('WA_TOKEN_EXPIRES_AT', 'token_expires_at ISO8601 (opcional)', { required: false })

  // The ONLY secret -- hidden input, never echoed, never from argv/env/file.
  token = await promptHidden('access_token (oculto, no se mostrara): ')
  if (!token || !token.trim()) fail('access_token vacio')

  const { data, error } = await supabase.rpc('whatsapp_admin_provision_connection', {
    p_business_id: business_id,
    p_phone_number_id: phone_number_id,
    p_waba_id: waba_id,
    p_access_token: token,            // parameterized -> bound value, not concatenated SQL
    p_reason: reason,
    p_system_user_id: system_user_id || null,
    p_token_expires_at: token_expires_at || null,
    p_business_phone_number: business_phone || null,
  })

  if (error) {
    // Durable failure audit WITHOUT the token (separate transaction).
    await supabase.rpc('whatsapp_admin_record_event', {
      p_business_id: business_id,
      p_event_type: 'provision_failed',
      p_reason: `provision error: ${error.message}`.slice(0, 480),
      p_connection_id: null,
      p_metadata: {},
    }).catch(() => { /* best-effort; never throws secrets */ })
    fail(`provision fallo: ${error.message}`)
  }

  console.log('OK provision:', JSON.stringify(data))  // { connection_id, status, event } -- no token
} finally {
  // best-effort scrub of the secret from memory
  if (typeof token === 'string') token = ' '.repeat(token.length)
  token = null
}
