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
const FP = '638e22963693de906942de579cd84d999ec82fb3c5df8957bb010d6ab7c82bef'
const N = 6

const KEY_A = `-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQCoBqLh2RvaHoLVzZcLlr/86gHEPrJkwCnveWz2x9Hr15dCpWQh
MCBakrHBrmyc1zYjbX6LTFR71W+6dSqlydA9qYRLTbojZjfUs4RIxkYE9tJUHCSY
2+ovkIzMRqqJypleK25ztNN5sNmVmf7/xAcMW7LFde+NFAIzdZ2Mk12MbQIDAQAB
AoGAFTspb7I4Q7phO9TLhipZPgLvkDV/4x0o71p/eztKeit2sHQnj839+JPapCd/
D95dt+JJAB73+eHBSWUuq14x0rRjn6F4RvWsnOEIVcoo8wT1NI/zOYgRdebTU49c
E4CsFObz5Hj9Abh7aylxWUKqxhp4EHIg/4IWTdlwUIdbGX0CQQDQ6TIZhf9SbN5d
s9zDOve5KyVUT3OkpL/ecG25E4uM8QCg/Jb/uD0C3oHVvy+jy2Mlre5N2bawahFb
3hDde2DTAkEAzeZAB3lIV1KQwyadtN6Pi/uIBmDksGShLjFw3SyPXA8jHKzNYLIr
OpraPVrnKA2jDTUB37uEfq5M9J1yocUVvwJAapE6bEitaMd+W0A/8hsneP6oaSyq
aidcdMTXQ9zTiA78aiLPiBzcipUkl/uR+rTqm7Lw6CeSCMXimwFZixG/3wJAVZV0
Xebqy+k05PkjKnAsSKpH0ybpR+y8FoBUgoqoGELufFfTknLchyKgvkoPtVVdxfqX
idDe9O0sba0YXeeW7wJAbf7OdE8SADZ5oTmlL3tqrxLwyp4ilvdrxIyijAPmvfZ9
cF6QzfCOLfBn53GcgzZnfaXMWer/loxMcqXShzk9Hw==
-----END RSA PRIVATE KEY-----`

const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBlTCB/6ADAgECAgEBMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMTBnMzYTEt
QTAeFw0yMDAxMDEwMzAwMDBaFw0zNTAxMDEwMzAwMDBaMBExDzANBgNVBAMTBnMz
YTEtQTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAqAai4dkb2h6C1c2XC5a/
/OoBxD6yZMAp73ls9sfR69eXQqVkITAgWpKxwa5snNc2I21+i0xUe9VvunUqpcnQ
PamES026I2Y31LOESMZGBPbSVBwkmNvqL5CMzEaqicqZXituc7TTebDZlZn+/8QH
DFuyxXXvjRQCM3WdjJNdjG0CAwEAATANBgkqhkiG9w0BAQsFAAOBgQA+gm9zkCgO
PHgkclDpuWait/sJQMziHgTxsypKVmY85JtPzG/oS3bIXU1SC0OQZSiuj79RZ+yv
mkRd3thhNFD1co1UCLEXLtd25+13/cYmgOHiCKk0TW8e2qZ2VJGDDyUtGt+JdMPT
mvNVCWyyxwRiE5vLiq/hlkuulMhrQNclZw==
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
