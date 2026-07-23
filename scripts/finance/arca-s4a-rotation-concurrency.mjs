#!/usr/bin/env node
// ============================================================================
// AFIP-S4A — carrera REAL de preparación de rotación (N conexiones simultáneas).
//
// N backends invocan a la vez arca_prepare_certificate_rotation para el MISMO
// negocio con DISTINTAS idempotency keys. El advisory lock por negocio + el índice
// único parcial (una pending por negocio) deben dejar EXACTAMENTE una rotación
// pendiente y UN secreto de rotación, sin huérfanos; el resto → ROTATION_PENDING_CONFLICT.
//
// Solo contra la DB LOCAL (docker). Fixtures SINTÉTICOS, se limpian al final.
//   node scripts/finance/arca-s4a-rotation-concurrency.mjs
// ============================================================================
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const CONTAINER = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-4000-8000-0000000054b1'
const USR = '00000000-0000-4000-8000-0000000054b2'
const FP = '7df61873a03248fa393cd8fa459c07f9061701a5d38caa8f11db8e08055b170a'
const N = 6

const KEY_A = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC54hq4PExnWCr/70pLL0Dy1S6OAN/pX78+1Vmxx5+vondTnKDn
0VvurZyys1v/7Qe0mxlkiGFKC3Gv8CRsP0PB4+/yrqzqVmQCs452jgdXd9cKoPkp
WLM204FHMHVfE5rWf8CRxNf5MVD0Bup+INThmEGoE6AkrfuHA4p/7i3YrwIDAQAB
AoGBAKaa1cATq5dlGwVSAJDqxZfhI1z7w7V0sAEtULtbZPES+UjjtgSRTYjb6vrw
b6EvXhyud0/4PNsU7sz2vG6ZNaxn/8NDO7asd+P+BcolZVWdtLJ7cG0MRTuI9k0l
QqKix8lW7F1mBhEZ7QJatXMQghHMddXOVICl2czRBdeZ1TeBAkEA1xqfLvwnrwZB
URUizhjzJAk6+zp29KF9fdrg/7JpFDP8zJ/wNm5ZwXkQjijTpYEd5TfLejjF+xWP
11acRFWM/wJBAN05RXhEwZJ4elIG7sPs8wTFbNaGybIJN7ZkztdZlJPHYAHdIUsJ
jgEQ/z5JtBQjRh7GSFDE1NSRVdZwe5vXxFECQFUnHM0k1TDccQ8AJv8fsWEapla+
FklRhLRF6bxPjHmK+xCmYBmsJawJmRwt3Vsvef470DlaMEXtizvb9ZC3rVECQCBt
z9A0jAezn4K8v217I5i0dCLyeUie70rOdj+9QvlyxZEgYEwGp4lie3gfB8XX8eR6
/ojQgb5zW5jmvkf3FjECQQDPxsa2Mr89cnZ0iP4cp34nKFQmGZvKNN90+xS9ubUq
HfVWPLaZG0m2gkkMBVVY1v6nm0gi0KPdRL7RwfrOVH3K
-----END RSA PRIVATE KEY-----`
const CSR_A = `-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAueIauDxMZ1gq/+9K
Sy9A8tUujgDf6V+/PtVZscefr6J3U5yg59Fb7q2csrNb/+0HtJsZZIhhSgtxr/Ak
bD9DwePv8q6s6lZkArOOdo4HV3fXCqD5KVizNtOBRzB1XxOa1n/AkcTX+TFQ9Abq
fiDU4ZhBqBOgJK37hwOKf+4t2K8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACbR
IYMXSBhYfqmODl+bwFACtUxri0VxRiz+L4BNv5uTDJbsAZ+rdu60j2l6quLeP1xn
Ysxa2E+Ei6hxg+LCBFfPxeRUasDgiUNsiAEJoCcbcP7Wf9n10SPWA24xJpqnk4+R
Ocn1j3b9fNlxDys0HR1qOWIk0R7FPdPVfA2/cVbY
-----END CERTIFICATE REQUEST-----`

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

function prepareCall(idem) {
  return `SET request.jwt.claims = '{"role":"service_role"}';
    SELECT public.arca_prepare_certificate_rotation('${BIZ}', $k$${KEY_A}$k$, $c$${CSR_A}$c$, '${FP}',
      'RSA', 1024, 65537, '{}'::jsonb, 'race-${idem}', '${USR}')->>'state';`
}

async function main() {
  console.log(`AFIP-S4A — carrera de preparación de rotación (${N} conexiones)\n`)

  await psql(`
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    VALUES ('${USR}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s4a-race@test.local','',now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S4A-race','${USR}','pro','active') ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;`)

  const calls = Array.from({ length: N }, (_, i) => psql(prepareCall(i))
    .then(o => o.split('\n').filter(Boolean).pop())
    .catch(e => 'EXC:' + String(e.message).split('\n')[0].slice(0, 60)))
  const states = await Promise.all(calls)
  console.log('estados:', JSON.stringify(states))

  const pending = Number(await psql(`SELECT count(*) FROM private.arca_credential_rotations WHERE business_id='${BIZ}' AND state='pending_rotation';`))
  const secrets = Number(await psql(`SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:${BIZ}%';`))
  const orphans = Number(await psql(
    `SELECT (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
            - (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation');`))
  const prepared = states.filter(s => s === 'ROTATION_PREPARED').length
  const conflict = states.filter(s => s === 'ROTATION_PENDING_CONFLICT').length

  let fail = 0
  const check = (c, l) => { c ? console.log('PASS: ' + l) : (fail++, console.log('FAIL: ' + l)) }
  check(prepared === 1, `exactamente UNA preparó (obtenido ${prepared})`)
  check(pending === 1, `exactamente UNA rotación pendiente (obtenido ${pending})`)
  check(secrets === 1, `exactamente UN secreto de rotación (obtenido ${secrets})`)
  check(conflict === N - 1, `el resto → PENDING_CONFLICT (obtenido ${conflict}/${N - 1})`)
  check(orphans === 0, `sin secretos de rotación huérfanos (delta ${orphans})`)
  check(!states.some(s => String(s).startsWith('EXC:')), 'ninguna invocación lanzó excepción')

  // Cleanup
  await psql(`
    DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id='${BIZ}');
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM public.businesses WHERE id='${BIZ}';
    DELETE FROM auth.users WHERE id='${USR}';`)

  console.log(fail === 0 ? `\n✅ concurrencia S4A OK` : `\n❌ concurrencia S4A: ${fail} fallo(s)`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('harness error:', e.message); process.exit(1) })
