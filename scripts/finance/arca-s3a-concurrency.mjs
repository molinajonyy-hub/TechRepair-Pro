#!/usr/bin/env node
// ============================================================================
// AFIP-S3A — carrera REAL de provisionamiento (múltiples conexiones simultáneas).
//
// La suite SQL prueba invariantes y el camino secuencial; esto prueba la carrera
// de verdad: N backends invocando a la vez la RPC para el MISMO negocio. El
// advisory lock por negocio + UNIQUE(business_id) deben dejar exactamente UNA
// credencial y UN secreto, sin huérfanos.
//
// Solo contra la DB LOCAL (docker). Fixtures sintéticos, se limpian al final.
//   node scripts/finance/arca-s3a-concurrency.mjs
// ============================================================================
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const CONTAINER = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-4000-8000-00000000fa01' // uuid sintético (hex válido)
const FP = 'a1e046a1d63dd9c3dc1a4374ce655774b2b44160186e17c4289995265e901c7b'
const N = 6

const KEY_A = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDMxn7XxB5qQKGO5sRmTWX/75taLaeWGm2/7/cfRswPptsZ5v4r
xG/fBPaowaVCYYnQDW3YfXje3ZIGu/ThSb3yNaDN/VGvEfPbv5ZCY4SDQluIgwr0
NTvsGjxnDpXhUC1vdgBb43YktHkG78ccaVUFk0rd0uiJSfEZvnLFLkin6wIDAQAB
AoGASTyouuSCeD/bSC+SiIAf/dQlPLBdYprbK61YNdBtRR/I9s+dkeu0kw/EZAC1
6TLXRhi3c5kUdKjMBCqO31AvZV/sY90Nek9+Sdfj1VSvMl64pN9nmYZVG4q2P2W0
vW1XUlKycG50SMbiqFuBjmQlN1CrKirnnNvKHzRvit1FhSkCQQDYSwdoTOU/wEDU
wZVWtDHYc+z053XPihFnpZ2yHAdRXsoutihP2lmW7N/s4s4/w8RFu3nI9DEZkuxI
hxwZL0k/AkEA8l4tUfnXMJ2OM8KhZs4UE6oqQtkucv2kqF5MBW/0bPU/XYpd21B7
4reNuwmBtNZznynwO4VQeUAZOiAjIy8qVQJBAI9GA/4fEayNGWTVZqssaehLwibo
O63ic20I09DrqB1KgPs4RrO+m6HR/vLXum+aqiTW7vEicHPUUxgoB4DXRdkCQB9B
zg54biwy5Zf/Tdl4UlaG55RfdgIWfBnKr3s0CQ3UQyvJIHmcU53Vlk282CF+VsL8
IaNLeilo/tfkNSPgfVECQQCh2bc5rFh3+8Idwr/d7lgL50jrDcLWvg0lyc7bXpsJ
/+4Tl6hfZjBVTBj1wmJxHCnx7GXLpZjurU0QbDrtRq54
-----END RSA PRIVATE KEY-----`

const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBpDCCAQ2gAwIBAgIBATANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDEw1zM2Et
Zml4dHVyZS1BMB4XDTIwMDEwMTAzMDAwMFoXDTM1MDEwMTAzMDAwMFowGDEWMBQG
A1UEAxMNczNhLWZpeHR1cmUtQTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA
zMZ+18QeakChjubEZk1l/++bWi2nlhptv+/3H0bMD6bbGeb+K8Rv3wT2qMGlQmGJ
0A1t2H143t2SBrv04Um98jWgzf1RrxHz27+WQmOEg0JbiIMK9DU77Bo8Zw6V4VAt
b3YAW+N2JLR5Bu/HHGlVBZNK3dLoiUnxGb5yxS5Ip+sCAwEAATANBgkqhkiG9w0B
AQsFAAOBgQCH4pmVtz1iLJaN+9gaTMZ689GTacxLFVq7lRJrf6NQ3/vykVkJa3BX
sFE0aJgJJTsicEbXT0nT2cRnnsg8iDsnVcqAlbVD6uR447nGtT/JSWbun0DRcu3h
n1PcYZetBrj1kdmjLVBJbCrv85SruEVSMR0GzCqtUpTtwz7HRCqNTQ==
-----END CERTIFICATE-----`

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

async function main() {
  console.log(`AFIP-S3A — carrera de provisionamiento (${N} conexiones simultáneas)\n`)

  // ── Setup (commiteado para que lo vean todos los backends) ──
  await psql(`
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S3A-race',NULL,'pro','active') ON CONFLICT (id) DO UPDATE SET subscription_plan='pro';
    INSERT INTO public.arca_config (business_id,cuit,ambiente,punto_venta,web_service,alias,cert_file,private_key,estado_conexion)
    VALUES ('${BIZ}','20111111112','homologacion',1,'wsfe','r',$cert$${CERT_A}$cert$,$key$${KEY_A}$key$,'conectado')
    ON CONFLICT (business_id) DO NOTHING;`)

  // ── Carrera: N invocaciones simultáneas, distinta idempotency_key ──
  const calls = Array.from({ length: N }, (_, i) => psql(
    `SET request.jwt.claims = '{"role":"service_role"}';
     SELECT public.arca_migrate_legacy_private_key_to_vault('${BIZ}','${FP}','race-${i}')->>'state';`
  ).then(o => o.split('\n').filter(Boolean).pop()).catch(e => 'EXC:' + String(e.message).split('\n')[0].slice(0, 60)))

  const states = await Promise.all(calls)
  console.log('estados devueltos:', JSON.stringify(states))

  // ── Invariantes ──
  const creds = Number(await psql(`SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';`))
  const secrets = Number(await psql(`SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:${BIZ}%';`))
  const orphans = Number(await psql(
    `SELECT (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%') - (SELECT count(*) FROM private.arca_private_key_credentials);`))
  const migrated = states.filter(s => s === 'MIGRATED').length
  const ok = states.filter(s => s === 'MIGRATED' || s === 'ALREADY_MIGRATED').length

  let fail = 0
  const check = (cond, label) => { cond ? console.log('PASS: ' + label) : (fail++, console.log('FAIL: ' + label)) }
  check(creds === 1, `exactamente UNA credencial (obtenido ${creds})`)
  check(secrets === 1, `exactamente UN secreto Vault (obtenido ${secrets})`)
  check(orphans === 0, `sin secretos huérfanos (delta ${orphans})`)
  check(migrated === 1, `exactamente UNA invocación migró (obtenido ${migrated})`)
  check(ok === N, `las ${N} invocaciones terminaron en éxito idempotente (obtenido ${ok})`)
  check(!states.some(s => String(s).startsWith('EXC:')), 'ninguna invocación lanzó excepción')

  // ── Cleanup ──
  await psql(`
    DELETE FROM private.arca_credential_provision_requests WHERE business_id='${BIZ}';
    DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='${BIZ}');
    DELETE FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';
    DELETE FROM public.businesses WHERE id='${BIZ}';`)
  const left = Number(await psql(`SELECT count(*) FROM public.businesses WHERE id='${BIZ}';`))
  check(left === 0, 'fixtures limpiados')

  console.log(fail === 0 ? `\n✅ concurrencia OK` : `\n❌ concurrencia: ${fail} fallo(s)`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('harness error:', e.message); process.exit(1) })
