#!/usr/bin/env node
// ============================================================================
// AFIP-S4B-2A — concurrencia de ACTIVACIÓN y ROLLBACK atómicos.
//
//  A. Misma rotación + MISMA idempotency key (6 conexiones)
//       → 1 ROTATION_ACTIVATED + 5 ACTIVATION_ALREADY_APPLIED, una sola
//         promoción efectiva, un solo checkpoint, cero huérfanos.
//  B. Misma rotación + idempotency keys DISTINTAS
//       → una sola activación efectiva; el resto conflicto / ya activada.
//  C. Activación y rollback CONCURRENTES
//       → serialización correcta, estado final determinista y —sobre todo—
//         NUNCA un par cruzado (certificado de una clave + otra clave activa).
//
// Fixtures SINTÉTICOS (RSA 2048 generados con node-forge). Jamás se usa el
// certificado productivo emitido por ARCA. Solo DB LOCAL (docker).
//   node scripts/finance/arca-s4b2-activation-concurrency.mjs
// ============================================================================
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const CONTAINER = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-4000-8000-0000000054f1'
const USR = '00000000-0000-4000-8000-0000000054f2'
const N = 6

const ALIAS = "fixture.alias"
const CUIT = "20111111112"
const ACTIVE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAzGvO4Dra7KaJRWD4nZLvWZNXon2atg4L650OAEybxZNh8hiS
q3/ykkRZakHAy/EnLOZ9oi+DbjZyx0Fnhpi4WS98y2PGKPBpS71rIujd3EmT2qzy
jm7vKtcGZ5XGL/Ujc7SAaza288aq5teUS5MYaiuI30vbLQRfl4xjRKhtGRolDVas
GZuL33SrvRVSEXKmgCratRRXKvlb9zSTPbPZGtVyib9sqJWScZknEXfp6K9dAn+4
9PwKwYGL+aN2mQeRDWvZ+67ztWfbRIvE9SFPXYdOsRVkE27qN8iQ2rJ8ZmPV0dqn
/dqOBwf/Lx3ILc7B86YPDem9f04Q7S0U4+qHhwIDAQABAoIBAAGZom/s5gPONere
HHQXT1pTJe92rjxYlc1NWGu2Lc35Hl4nxRYklUCB2nVTeG/gPl9Cmp8nYg79zB41
K9tI3MCN95sb99QgNaLLI8iNLBdqWAbxLaDhy2t5bWpoKLn9YD6qngq4zevQlUvj
ShzhVOKX3qVo0ZljnF/yUGCcNOZqY2QPeFmFcPvScD4+1yXp2u76SkwrthC5o/Ny
0SNorwjO+y6oom4/3pxqIhedEd23YfIQ54mt8SrvRkjps8zhacw0iCsguGj5qZ6/
0uqAqFz50uJtLWsNnoBKKN7qmUuYIDrMoF7UvaSiBkkO3tW5JB+U+jNv0E7rawlB
SDrTBGkCgYEA74NsgtuS0maYvvTa112Ro1Uwjjx1Rji5qOL98dDyAFLrMArUD2pH
UbcB6JAulkpmoq3uWa6sU6iND79UKfzyNzI2OH2f69j29zcrY6sgseAx0sgt4JJg
R177U1hLYr08gdlfDEAck/MfVGZm6vp9I3xZiaALj0oq2FpUunT39xsCgYEA2n4B
6N9S08n9U701SutE5M+LYLOAggHdjZuQqUvpDG8UrncGxBm6HKhBKKye623BKWOd
DCUi4RO+eyLcqqJ20k/RI+hoFnwXxGh5/1EzlTBkBoOSQgRIPxZZ4qYZJYqAvc0j
sfgSkxeRYOMVu3gyQckWvB2Ee7CIi5MvcNYfXAUCgYEA5RnxUbp2VouM0BumuRrn
lDSInYV3KBRagxGdlxEmaujlzq6M6bHfRmqniK1h4qCITFPTCjXq4Jr5U3bQKtmp
VuLQunhv4ElI8m/zMQMf4wVwow6X05gwQBS6kp6CfZBFsG8cW7t3mo2UCkdpaprv
2GG5w8szQ3zOPuUo5rG7/sECgYEAlQLLGp70RizD8JBiAC5kVgiV7eV+ByxuhV1L
U6rJzgkT+ciDfMpu+4xko/DWkYnQ6wFc4iORnh9xEVm9VUJn9xcoc2zVUEBhlToL
ue0PWPgfv7GL1ipFe4Eq3ECbddb35no5le6x/E9efs1gzPI0lFkogDNBX3oOJeLD
wBjIWmECgYBhGaW8SQkTSBgvhtZ+H07KKHKWogiTZYLYWvCPj/ssU3X3ejR4wm12
JwjHajEqQbQze7Rp0h9sAvpCIP5eyAef+vBlqEuSy4m8FmgoE+bu/aeKApbFXzs6
0aqIANL9cUE29J+PxprrID8mavLBc9OSQC///seumhaMA2TMeVmgwg==
-----END RSA PRIVATE KEY-----`
const ACTIVE_FP = "13861caf92ad1ae5c91cac27e49baca86328d7287ef642742cf3435b34a1366e"
const ACTIVE_CERT = `-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAMxrzuA62uymiUVg+J2S71mTV6J9mrYOC+udDgBMm8WTYfIYkqt/
8pJEWWpBwMvxJyzmfaIvg242csdBZ4aYuFkvfMtjxijwaUu9ayLo3dxJk9qs8o5u
7yrXBmeVxi/1I3O0gGs2tvPGqubXlEuTGGoriN9L2y0EX5eMY0SobRkaJQ1WrBmb
i990q70VUhFypoAq2rUUVyr5W/c0kz2z2RrVcom/bKiVknGZJxF36eivXQJ/uPT8
CsGBi/mjdpkHkQ1r2fuu87Vn20SLxPUhT12HTrEVZBNu6jfIkNqyfGZj1dHap/3a
jgcH/y8dyC3OwfOmDw3pvX9OEO0tFOPqh4cCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAy3IM4Ch3zomXmSVrWJxdV82HiGGsTkp/buzC77LwM+RjQGGUj+glJwnEWAOQ
fAZBxHznL3mTaA9btN49VTnI8uDcGlpQT8Ln2JBk/wshFzJsbP13nPMhpWMGq7pr
jr83fJmKldeMmIWgYcgVJw3HDfifzadVBtlVzI+aVo9AdMHJYxrkX5KN30h89Rzn
iRINXRIlaL9Ps8PNrtZ2UxegPGmb0IwnK4XhrlRyj8EInaLPnS/w/Gv0sGQqLSKV
umg23sHBXkwxZDP9dmDfuiJI4duR6DGi1fkksrc+n/9UKdlqQz546WWf9btVC77S
Q2Ik8rRYIrxdCTu1leoP98kHQw==
-----END CERTIFICATE-----`
const PENDING_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAutdg4soIt1bB667K+wf732iNmUoBS2pQbUNHR02XWHPc0+CC
fw3b/1kATduWRX35mRObZHYxGVz2UOGu9IQPv8Sd9OyYf3buBezkxmcTu8Lb2Vv4
XEyqmlMLx7GeCvjAdLSyXEHLDQmnDvV0TaOuHCv12ej7VajR2u0PcL4mFRJsq13Q
25zc5ESqNSr4YYLOu8XWhX5rGMEwDvlYiEDxeQES1GKFMlXl7BgpVlL12OYEJcBM
EkfrRki/4zUhC5Rf+akNCijcc9MooZorTqqVE/Y97uw8h0MsEzNvImvK0SWa9te/
PcFYdWsl0EW5jzrKuSgYCTZrUqn9HlXEM74KSQIDAQABAoIBAQC1hjsjG5aMSUXu
bMvYSFF1JGct3rCTTJ8HCK5foArCbQ7G6wDd3+E1nIqnGghNS68MAfifChV5xs+o
lRsdhJCoh6XPJ26hqDJon1dFSy/o49AkxS3uvq2hcb2oLfCWSEbzG/uNln5oFFCy
P9bW94dY53zcUXaeKn54bIjryFHHdYtNacvaa8tiXhsl+Hbsw5nhOxzGjt2fzY1B
wSwUyw5V12uulMuXhH2Ig3L1qbNtcdHWInMPS2sVvvXfYWg/78KSZQr8gHqcc77z
oWnBuMBXW48OnB8eynDrYg6SfhVtyxF0ncejnWHCxhIvbYGmE152kThXLsKA6sTe
uyBbBJZhAoGBAPU68Py9joYKwGFSYc45JHUIZpIs/WGquthvHqTll0hT37/u4EnI
Teby/w+ryOz+Scq8eYvkil5/uBOdYsmX3r7MEmxBplljRy449TQ1p7KWg4ejJrRs
gIio2Kmv0gD6YEZDd52RghiGvSsDf9923sXWLnqyJGrZqSS6QdDqr2gvAoGBAMML
/GhIrQRrJzWqxbQPPNcPT7ULbCUhCqHMolNPU7xgQhf6gqx0zl5SWf61IoYTO0AJ
kZfu9fUdHMz1egzz6yRONIDvD8BZ22lhRvU4M3o+SvZ0xN2FzHMlDz2IbASnIff4
gDcGUhOkBpLq4WF2a+Po7USIB2FzcyLIPUDwU58HAoGAALvAZMEcYAJAOQpKCJfb
KA5yYBWKXHRqQqNycAPPxAOcM7K/MPlMYlhvsthMrYjFJ7oQkv6H+2heYJCj7v5p
SCDMHU7E9Jd7awP4l8NhUQNqOUmfoAKDD+WRYFCKTD5zc0JYZTw+K1ybzDkidMSi
Pe06DlviB//Gpbl44OsSwzkCgYA2wsa7AKyS8QKxLqETTLPoLYRTcEGMqxoxEyMA
AOWhneTwloTZpnHKSZS6zmBDBGM+N3GJFq43g1Tytnjt6g26w7o5+OSTPKc9jvI9
JupNB/BEAcTD7SzZpy4AOK0bIVGILVzSFhQ1L3gpB4j/tB/WfS8gbpCj66YHvfB0
qwTPQQKBgCFpM497imJSuj+c1raD/N8TebN/+OFKmGRNRGsjWBfuHp+U7FKvCSie
oyYrUH/8YXIgVL6PaUOKMGlVOrPINO5ZvNaLlgaehUvarx5gCO9Hp0eom4uvfDdm
yxpWoxJOZdgTlNNFgbQ8AKsfYq8H+vg0PJeyP66pT/toJ12U4Mip
-----END RSA PRIVATE KEY-----`
const PENDING_FP = "dd04bd34d4fe9b08fad856d1bed1ba8250b501a6aa1ae8077d2d515a514c11fb"
const PENDING_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICeDCCAWACAQAwMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcGA1UEBRMQ
Q1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N2/9ZAE3blkV9
+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxMqppTC8exngr4
wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc3OREqjUq+GGC
zrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH60ZIv+M1IQuU
X/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3BWHVrJdBFuY86
yrkoGAk2a1Kp/R5VxDO+CkkCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQCHwQOB
ytwmU9YgzrLtokWQAc/zHn/p84fCX2saY/ZkBK6ktpcuhsRLta165HCiQwUuwR2K
LFlwep+ff6fzhqYIEe6FknzI6Pb2hTrRBIa5W1lkgnxUNJ49kb5T988zNZzj7jhC
VHlvOrH7xoiE5UWVj5AAK2XwnWwlphNIotDv5LXBjB/Lb4din3tuHLqt0HsMV1ID
ZJ/FjJ7XpJjt0sVoul02iYpdXA5/qy7DkytBlpdkd/gO/bL90vfuHlsoLn0+JgwU
v6S5yIdbnkFPHT/ss9hATh/h5Rs40yU+0btz08IjKKR3xLGBiXSsk03/32MMAr3u
86Uocxe/wymOu5Xu
-----END CERTIFICATE REQUEST-----`
const CERT_OK = `-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALrXYOLKCLdWweuuyvsH+99ojZlKAUtqUG1DR0dNl1hz3NPggn8N
2/9ZAE3blkV9+ZkTm2R2MRlc9lDhrvSED7/EnfTsmH927gXs5MZnE7vC29lb+FxM
qppTC8exngr4wHS0slxByw0Jpw71dE2jrhwr9dno+1Wo0drtD3C+JhUSbKtd0Nuc
3OREqjUq+GGCzrvF1oV+axjBMA75WIhA8XkBEtRihTJV5ewYKVZS9djmBCXATBJH
60ZIv+M1IQuUX/mpDQoo3HPTKKGaK06qlRP2Pe7sPIdDLBMzbyJrytElmvbXvz3B
WHVrJdBFuY86yrkoGAk2a1Kp/R5VxDO+CkkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAWC67EDh+j7uHexeXO/iH1QTerGF5sCmiAJj3TqYhR6dyxnm///cbgdF/kQ9W
xYVhYRVIFQVLENmlWWR4H/q8K0I24ku4WtGPGv+DDHhykkBtvgS6BnDsGAutj7HX
ycI0LB6zlIFlKogRQugtBXxAJUilP9W4s12eojYXjdi58c0pJrcbuHkPCAqMztAj
FL+twd2yy06I462AhBRlV3iqdRLFoesx3AheMGsR4L1YptEKKWBvNeV/NzT8qANj
bOnlnhsrzf9hczdN1LYK+Qsx8U6vyulkNFcnEn9X8FH1SE6csN5qw2r6l0BzXrMT
iz2Ex9UCSexFjMpkRhjsqVaD+Q==
-----END CERTIFICATE-----`

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A',
    '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 20 * 1024 * 1024 })
  return stdout.trim()
}
const SR = `SET request.jwt.claims = '{"role":"service_role"}';`
const activate = (idem) => `${SR}
  SELECT public.arca_activate_certificate_rotation('${BIZ}', NULL, $c$${CERT_OK}$c$,
    '${PENDING_FP}', '${idem}', '${USR}')->>'state';`
const rollback = (idem) => `${SR}
  SELECT public.arca_rollback_certificate_rotation('${BIZ}', NULL, '${idem}', '${USR}')->>'state';`

const last = (o) => o.split('\n').filter(Boolean).pop()

async function reset() {
  await psql(`
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM vault.secrets WHERE name LIKE 'arca-private-key%:${BIZ}%';
    DELETE FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';
    INSERT INTO auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
    VALUES ('${USR}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s4b2-race@test.local','',now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S4B2-race','${USR}','pro','active') ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;
    INSERT INTO public.arca_config (business_id,cuit,alias,ambiente,punto_venta,web_service,cert_file,wsaa_token,wsaa_sign,estado_conexion)
    VALUES ('${BIZ}','${CUIT}','${ALIAS}','homologacion',1,'wsfe',$cert$${ACTIVE_CERT}$cert$,
            'TOK','SGN','conectado');`)
  await psql(`${SR}
    SELECT private.arca_store_private_key_secret('${BIZ}', $k$${ACTIVE_KEY}$k$, '${ACTIVE_FP}', NULL, 'RSA', 2048, '${USR}', false);
    SELECT public.arca_prepare_certificate_rotation('${BIZ}', $k$${PENDING_KEY}$k$, $c$${PENDING_CSR}$c$,
      '${PENDING_FP}', 'RSA', 2048, 65537, NULL, 'race-prep', '${USR}');`)
}

/** El par activo SIEMPRE debe ser coherente: la clave activa corresponde al cert. */
async function parCoherente() {
  const v = await psql(`${SR}
    SELECT private.arca_key_matches_certificate(
      private.arca_get_private_key_for_signing('${BIZ}'),
      (SELECT cert_file FROM public.arca_config WHERE business_id='${BIZ}'));`)
  return last(v) === 't'
}
async function estado() {
  const fp = last(await psql(`SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';`))
  const st = last(await psql(`SELECT state FROM private.arca_credential_rotations WHERE business_id='${BIZ}';`))
  // AFIP-S4C: filtrado por NEGOCIO. El conteo global se contaminaba con los datos
  // de cualquier otro harness y hacía fallar éste según el orden de ejecución.
  const orph = Number(last(await psql(
    `SELECT count(*) FROM (
        SELECT private_key_secret_id AS sid FROM private.arca_credential_rotations WHERE business_id='${BIZ}'
        UNION ALL SELECT prev_secret_id FROM private.arca_credential_rotations WHERE business_id='${BIZ}'
        UNION ALL SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id='${BIZ}') q
      WHERE q.sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = q.sid);`)))
  const creds = Number(last(await psql(`SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';`)))
  return { fp, st, orph, creds }
}

let fail = 0
const check = (c, l) => { c ? console.log('PASS: ' + l) : (fail++, console.log('FAIL: ' + l)) }

async function main() {
  console.log('AFIP-S4B-2A — concurrencia de activación y rollback\n')

  // ── A: misma idempotency key ──
  await reset()
  let states = await Promise.all(Array.from({ length: N }, () => psql(activate('race-same'))
    .then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60))))
  console.log('A estados:', JSON.stringify(states))
  let s = await estado()
  check(states.filter((x) => x === 'ROTATION_ACTIVATED').length === 1, 'A: exactamente 1 ROTATION_ACTIVATED')
  check(states.filter((x) => x === 'ACTIVATION_ALREADY_APPLIED').length === N - 1, `A: ${N - 1} ACTIVATION_ALREADY_APPLIED`)
  check(s.fp === PENDING_FP, 'A: la credencial quedó con la clave nueva')
  check(s.st === 'activated_pending_verification', 'A: rotación en activated_pending_verification')
  check(s.creds === 1 && s.orph === 0, 'A: una sola credencial, cero huérfanos')
  check(await parCoherente(), 'A: par clave/certificado coherente')
  check(Number(last(await psql(`SELECT count(*) FROM private.arca_credential_audit
    WHERE business_id='${BIZ}' AND event='arca_certificate_rotation_activated';`))) === 1, 'A: una sola promoción auditada')

  // ── B: idempotency keys distintas ──
  await reset()
  states = await Promise.all(Array.from({ length: N }, (_, i) => psql(activate('race-diff-' + i))
    .then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60))))
  console.log('B estados:', JSON.stringify(states))
  s = await estado()
  check(states.filter((x) => x === 'ROTATION_ACTIVATED').length === 1, 'B: una sola activación efectiva')
  check(states.filter((x) => x === 'ROTATION_ACTIVATED' || x === 'ACTIVATION_ALREADY_APPLIED').length === 1,
    'B: sin doble promoción (el resto no activa)')
  check(s.fp === PENDING_FP && s.st === 'activated_pending_verification', 'B: estado final correcto')
  check(s.creds === 1 && s.orph === 0, 'B: una sola credencial, cero huérfanos')
  check(await parCoherente(), 'B: par clave/certificado coherente')

  // ── C: activación y rollback concurrentes ──
  await reset()
  const mixed = await Promise.all([
    psql(activate('race-mix')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(rollback('race-mix-rb')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(activate('race-mix')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(rollback('race-mix-rb')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
  ])
  console.log('C estados:', JSON.stringify(mixed))
  s = await estado()
  check(!mixed.some((x) => String(x).startsWith('EXC:')), 'C: ninguna operación lanzó excepción')
  check(await parCoherente(), 'C: NUNCA un par cruzado (clave y certificado siempre coherentes)')
  check(['activated_pending_verification', 'rolled_back'].includes(s.st), `C: estado final determinista (${s.st})`)
  check((s.st === 'activated_pending_verification' && s.fp === PENDING_FP)
     || (s.st === 'rolled_back' && s.fp === ACTIVE_FP), 'C: fingerprint coherente con el estado final')
  check(s.creds === 1 && s.orph === 0, 'C: una sola credencial, cero huérfanos')

  // Cleanup
  await psql(`
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM vault.secrets WHERE name LIKE 'arca-private-key%:${BIZ}%';
    DELETE FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';
    DELETE FROM public.businesses WHERE id='${BIZ}';
    DELETE FROM auth.users WHERE id='${USR}';`)

  console.log(fail === 0 ? '\n✅ concurrencia S4B-2A OK' : `\n❌ concurrencia S4B-2A: ${fail} fallo(s)`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('harness error:', e.message); process.exit(1) })
