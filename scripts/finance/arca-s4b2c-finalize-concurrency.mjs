#!/usr/bin/env node
// ============================================================================
// AFIP-S4B-2C — concurrencia de FINALIZACIÓN (y su carrera con el rollback).
//
//  A. Misma rotación + MISMA idempotency key (6 conexiones)
//       → 1 ROTATION_COMPLETED + 5 ROTATION_ALREADY_COMPLETED, una sola
//         transición y un solo evento terminal.
//  B. Misma rotación + idempotency keys DISTINTAS
//       → una sola transición efectiva; el resto ya completada, sin corrupción.
//  C. Finalización y rollback CONCURRENTES
//       → el advisory lock serializa, el estado final es determinista, nunca
//         queda un par cruzado y ningún secreto se borra.
//
// Fixtures SINTÉTICOS (RSA 2048, node-forge). Jamás se usa el certificado
// productivo emitido por ARCA. Solo DB LOCAL (docker).
//   node scripts/finance/arca-s4b2c-finalize-concurrency.mjs
// ============================================================================
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const CONTAINER = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-4000-8000-0000000054d1'
const USR = '00000000-0000-4000-8000-0000000054d2'
const N = 6

const ALIAS = 'fixture.alias'
const CUIT = '20111111112'
const ACTIVE_FP = '21a64c517e8071808e46897428e1540026c5a781c8af0727fcab227bd44de2ad'
const PENDING_FP = 'fda3f718f6bfd96a576c5a551843112c2826e0129a43a1c960c2bce9ba9b9dc0'

const ACTIVE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAq45KCGErqCekYWFHtRHyexd2uvwsxejO6Pwpm1XvW4EaLhh5
1WrlX57uzpnAgQAfo86Rf5oVKuBdhGI4KQBwKH1vFR3K0gezPF8UzDyIudhKq1jt
0MtUAPiTp5rWK6IWYv4x2vwTY9AWYzW5ec0utXVfuo8mFZJxsdOsN9YhbNfxe6VT
pcqf7YC9gxn6ULPE+LyUXdR1u5QOvaYrkBdRqVH0Sk0NI6jZ5vKMMKRmC4RLHB5P
bkSGrvGz0tg7wzks7EXGJxuyE6fII5k8YYij6bVBFZpnoegnAzeosmKlIp+lFHtu
E6QsAnm5ZyIp4BQOYxkSAyCdX1lEI8WsJo5bCQIDAQABAoIBAHvMcXY8kOGGweOX
7MQo0F+tXfuvUKv8xZtxpKC40cKplnffJ8QvoJhxO4mRgE5XBX4S6gI38cCAKlwG
+Nn1u/osEkYduqf38IrHXl3H7S6Xe8LMqMj8gYE14G+Zl6XjEN6c6uNI9sEXf6BW
O6M+ws8lhVA+TtBQXoVh56xfdL1ypRIpW/By9P2OdroLxswW/dvVxTEgOZRSAqiL
8N8JQUKLJNbpT/jQGXV2W42GezLnT5oLQ85FDCy9YJYIY8nSthP1s94XVcv65AXV
i5ZVukvv3lR+1ra+ZUq8qqx+x9BnOCQ9NmCxoP6Fz5Fk9OaoyYK9Bs+hFuhjcykj
umeaJkUCgYEA04Ggi8pWdwTws7KVByM64WmnnGWorCeuee1fnegymp7f6zjSSJ3f
QGieB9fddpS81E86x+FZxkqXEwh7cwwi/mteF+CSq1gGC1t/f9ik2PCmYpgtc/l3
bs1qvup0SEjXdhhGmfJAQ60FJYCMhlIOd4rh4dFExyKxATWaBHZ3/M8CgYEAz6Uu
zT/rtzs5G8GODjdzG6fKBOsD2fcsssAOCIWL/kiBCG9FWMZgM0qzixCl2Mq/zqhp
LyshfGvb4+kFrC6ItNSaXIt4MpwJlOTuzv/UUEFQ8INzDRoEQJ5extxFXBpLb8Fi
13yueWRrC3rGbj5cBiwWjMgasMEaJ5zjeWuskKcCgYEAjlK3+dkZ/dTxM7qD1d27
DVvPUcqGifHZ0moM4XESPEGUY/BEcGDrjafYT2bOu7CysBrwbvgRNQGUT1Zx26Tb
F2CgXGjdyTbeOl5DmX/qzaCCFe5ZB6Vi3MiVgAq8XLfHZMxJFeaRn/iZcfbimLA2
0/I8tXvgUC/j8/Bhx4cAjrkCgYAKTbQI00crDHFFA1G9OtsnYCgSHmdOhYleRVFs
8tODhq2AcaULRqy3XtmR6P2RyF3EL28ovAcpWWDL6mAxrw1xi6stNG5+dGe1T7bZ
5q/uW49cn+kxmTzkx/cD/yIh89wSa5IwByvRMj5tj2YRSl7en4lu6u8IHkzh8lMH
T2R8uQKBgQDCvG4F16rlR3QbOQ8Fhxe9srTpdA/z9Jz4uegzlnHzxH+shca0ORDm
BrYr+K5k3Gpo5oSDRwDE9LObUBeYLTWNux411o7wUTlTE3OrSsw9Bkn4egz4RtXn
osla9bm84PeQoUXZqbu4H0i/d/ZZi6upMPTeyV60vCybCX0bWZq+Vw==
-----END RSA PRIVATE KEY-----`

const ACTIVE_CERT = `-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAKuOSghhK6gnpGFhR7UR8nsXdrr8LMXozuj8KZtV71uBGi4YedVq
5V+e7s6ZwIEAH6POkX+aFSrgXYRiOCkAcCh9bxUdytIHszxfFMw8iLnYSqtY7dDL
VAD4k6ea1iuiFmL+Mdr8E2PQFmM1uXnNLrV1X7qPJhWScbHTrDfWIWzX8XulU6XK
n+2AvYMZ+lCzxPi8lF3UdbuUDr2mK5AXUalR9EpNDSOo2ebyjDCkZguESxweT25E
hq7xs9LYO8M5LOxFxicbshOnyCOZPGGIo+m1QRWaZ6HoJwM3qLJipSKfpRR7bhOk
LAJ5uWciKeAUDmMZEgMgnV9ZRCPFrCaOWwkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAPPI8YZ2T7HPHKAFi9Scc9AqW4lPzxcAcbFewAz/FufV2bFeevaxgjpFAfpwH
YHCh8Pby0VLky6Tj1igRqDaIXIPMRnQ7rtr0PmBd9Zzik+ACvnGRtvBaORFHWFqS
EeLNEwNmcgarNnYnwi1eQq4M5HVGSKxeZS8Msg0heb7BUmZVehP3a3fB39ffdL2w
ZL0uWwG18A72nymfZEDIFcI2j16WGKMDTEd61C1McyiDhWCkRqRf21DLnQP1FpxW
MP9xh2UoBbxhQgRoRg8kHQ1jDWUpYTmtsr0jFWrMZMCTumIZ7/FfZq2Qe181YNMD
sSiIyIkmE4mF9i3ifJ9de51fPQ==
-----END CERTIFICATE-----`

const PENDING_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAsgFPjNCFCCbNTaJZ/aiNje5TdR6kyFChSZMf2sxp8OSBxLt/
3s3dNkx8NoMJTsdVKJeWpyOaM+ZekAG8nLU++nqFNtRKSRclgS7kZngjnAkwbfSt
0/vxNfx+Qb9u4dpaxerE1yV2DWMf1HT89s30shkbZLGE0Q11jD2Gz0u4O8zHfKnx
bFEX1uu34eyZPJvVLBPBA3e5eOE5KgDxincrd5LWYqh1SIXdLAlU/XnY0CQ8DEv3
JphshFTUUwY8FhN2zVc75khAzFgRt/a4GlktBQC8vXM6qpSTyzyC5cAdXq6HL/Hi
oaWVcRRnviUntaX8y61tT40AShiHTyDIqs/uPwIDAQABAoIBACQYIfJSwfbyL0Uj
u4205Oc3wVKJYS6BMwNBQv9R3dWL8EhdIMOkCMwe3D0NexCvWLQ/cLv5eyY0+03G
HGHGWrvdpi+FAn8po2A7ivLAP7A/KMPTDoBioPmqdkuMrsY7SZbCUSGzJen3BJhH
FJhTEOAgOS7E1EKzsPc77p8QIo51VAUA4vLhSwWV3d0z/halA/U8vu3aDG9QD9vL
63b3PwlC8Syy/Z+4S+t7EAFGRJ2KHNS8RsTo2W1ReIThptysrFrVhzPqVdscXpXE
KJF5k9d7MQ9lR5mMp+WaLxRoRhbpfdhFxSsXjqTmyIJqbyEwWidnoe86BFO/qgC/
VVuMfSECgYEAzOgDcbclM9LXPNqhRcOn3W7blcCcEA4gzuA1tbgpp6QubFHyZ5EP
MuD813iJPblhkkZsiRi8BbH8X0Tz4HspPGpOEWiVXCo4LAPT/65DQsaRiyo8IWB0
KWjvTc8wfDdYk/2ZAdTRZuuousUAqO8ncHvhVGCBIsazA3WzeRuFPnECgYEA3mQW
Z5f2ZXQVVrvSCLJH47z5hOKicSi0cuvY7OYcn2veHb99n3lblj5ap4wGFl0Am/aq
ovz5RaBgZazrd/mMhvOiUIJ8NPSvnOvkB1qmGbCrZxRMDuPoGR+M0sqidc5TGoTm
rB2WytIkHv5Jgp2919nKLwhIf3OPyP/VQfE7r68CgYBfVrCLj3h61WYaRWt2R2Pq
jrMSyWyTt88iEoZLB+Yxvx1ufu53q7HTrYVXSBkrI/83DRdg7qZFTBwtw6ppT0TP
fHLYfL3KBUbfi+Ru+YkIH9YGV19k9Dj4L3/wxy87DJFlQkCX7oqEBbAbPqBg+e1y
0+Dy3ngXUzZlrLUV620isQKBgA2z0QWVAWOC4YW0kN5kTbWkgSNE64lZXrTt/zGp
g/32oXrnv4/B5Hi/YsqMABwEovL5Ic5lE97MYOQi4WdFAvmVrVyUjZ6drOxYRHaH
iVBv6D+zqnQIataRcRXT0mq7ybcKlUPpls7sX7lhJZpcqcPQ8XowYncn4aYazUMA
4BKVAoGBALsrbIA1sUKOGgs4qQ7k2nRhLNksQakWZ+UwkGUpAcEBz06eyDgLmRcA
uPjQOYUb6vs4gh6E3wkv8eGJ/E+Dwyw2leWpkKp0GKuhSRPXQl6RIbhK14imb73k
0LwRPNDf/hcevHt5UsPh8WcnowfZ+XIyjlger3PmJaJmGxnQHO8c
-----END RSA PRIVATE KEY-----`

const PENDING_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICeDCCAWACAQAwMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcGA1UEBRMQ
Q1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N3TZMfDaDCU7H
VSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP78TX8fkG/buHa
WsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxRF9brt+HsmTyb
1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaYbIRU1FMGPBYT
ds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGllXEUZ74lJ7Wl
/MutbU+NAEoYh08gyKrP7j8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQAmVirZ
sZhdXpK1be9QcFpsYVMAeEkCmga2P/xmuWyV/fK8PlSlfXfAuPuq0coQQVUJMNhK
51nqLaPlx0z0w/tUDrRlEz1pPpXvk/4hW7J5gMjISBOM7He7um1/u1rHkMwEO4oU
1oi4tOZoF7Fx+3LzozPs3+1DkHutvWA/OY2DJpWv4bPlQRERJZxhWYH+OVjAO7if
S/7L1KKRHWb/PbsBokscbzlQi+SPH1Xfzmyccr7ancEsDDw8yD4/vWSudAO2ndXs
ahaRKTy0PJGbHi2a2TPQ610ELt9k+eKpcozbPx2y1IsXnEB/e+UV6buRSScyrYk7
s9dCZekH1wjeKnmq
-----END CERTIFICATE REQUEST-----`

const PENDING_CERT = `-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N
3TZMfDaDCU7HVSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP7
8TX8fkG/buHaWsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxR
F9brt+HsmTyb1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaY
bIRU1FMGPBYTds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGl
lXEUZ74lJ7Wl/MutbU+NAEoYh08gyKrP7j8CAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAFMQtjF1s2BYbBKlXfL/qtXh2TKLT3D6u9bzWDyZWpfIS25Pbi5GJzr8S2LxP
MhpYzcoHtKdOn9B1NFxRMvNOI8uBMXC/Nr0oiVvbnsVx4+VrEEG9ghaPzlYvUYhG
UIPSLzeV61/T2jfs0X6rrKk0lPDnPvRKb51mtumGCeL0ZQAwAQSa3g8H8cWzHGq3
VEJR7zoWeAX/59pPKP8Q33xbaiDkNfYrYl7NBeHG7xWr0HoHVotNT1RIglABZg2f
/1lxdVxzaBwn64zSavyi8H6FEdTrFzwtpl/O016uiDW79HVPDwIIxNWHZIjS5HZI
c2GUUOQ7kyv4kiP5Hz/+MYw5xQ==
-----END CERTIFICATE-----`

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A',
    '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 20 * 1024 * 1024 })
  return stdout.trim()
}
const SR = `SET request.jwt.claims = '{"role":"service_role"}';`
const last = (o) => o.split('\n').filter(Boolean).pop()

const finalize = (idem) => `${SR}
  SELECT public.arca_finalize_certificate_rotation('${BIZ}', NULL, '${PENDING_FP}', '${idem}', '${USR}')->>'state';`
const rollback = (idem) => `${SR}
  SELECT public.arca_rollback_certificate_rotation('${BIZ}', NULL, '${idem}', '${USR}')->>'state';`

/**
 * Deja el negocio con la rotación ACTIVADA y la evidencia WSAA posterior, que es
 * el punto de partida real de la finalización.
 */
async function reset() {
  await psql(`
    DELETE FROM private.arca_credential_audit WHERE business_id='${BIZ}';
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM vault.secrets WHERE name LIKE '%${BIZ}%';
    DELETE FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';
    INSERT INTO auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
    VALUES ('${USR}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s4b2c-race@test.local','',now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S4B2C-race','${USR}','pro','active') ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;
    INSERT INTO public.arca_config (business_id,cuit,alias,ambiente,punto_venta,web_service,cert_file,private_key,estado_conexion,expires_at)
    VALUES ('${BIZ}','${CUIT}','${ALIAS}','homologacion',1,'wsfe',$cert$${ACTIVE_CERT}$cert$,
            '-----BEGIN RSA PRIVATE KEY-----\nDUMMY\n-----END RSA PRIVATE KEY-----','conectado', timestamptz '2030-01-01 00:00:00+00');`)
  await psql(`${SR}
    SELECT private.arca_store_private_key_secret('${BIZ}', $k$${ACTIVE_KEY}$k$, '${ACTIVE_FP}', NULL, 'RSA', 2048, '${USR}', false);
    SELECT public.arca_prepare_certificate_rotation('${BIZ}', $k$${PENDING_KEY}$k$, $c$${PENDING_CSR}$c$,
      '${PENDING_FP}', 'RSA', 2048, 65537, NULL, 'race-prep', '${USR}');
    SELECT public.arca_activate_certificate_rotation('${BIZ}', NULL, $c$${PENDING_CERT}$c$,
      '${PENDING_FP}', 'race-act', '${USR}');`)
  // El refresh WSAA verificado de S4B-2B: cache poblado + evidencia posterior.
  await psql(`
    UPDATE public.arca_config SET wsaa_token='TOK', wsaa_sign='SGN',
           wsaa_token_expires = now() + interval '11 hours', estado_conexion='conectado', ultimo_error=NULL
     WHERE business_id='${BIZ}';
    INSERT INTO private.arca_credential_audit (event, business_id, fingerprint_trunc, status, created_at)
    SELECT 'wsaa_private_key_resolved_vault', '${BIZ}', '', 'vault', activated_at + interval '1 minute'
      FROM private.arca_credential_rotations WHERE business_id='${BIZ}';`)
}

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
  const terminales = Number(last(await psql(`SELECT count(*) FROM private.arca_credential_audit
    WHERE business_id='${BIZ}' AND event='arca_certificate_rotation_completed';`)))
  const secretos = Number(last(await psql(`SELECT count(*) FROM vault.secrets WHERE name LIKE '%${BIZ}%';`)))
  const finalizados = Number(last(await psql(`SELECT count(*) FROM private.arca_credential_rotations
    WHERE business_id='${BIZ}' AND finalized_at IS NOT NULL;`)))
  const expires = last(await psql(`SELECT expires_at FROM public.arca_config WHERE business_id='${BIZ}';`))
  return { fp, st, terminales, secretos, finalizados, expires }
}

let fail = 0
const check = (c, l) => { c ? console.log('PASS: ' + l) : (fail++, console.log('FAIL: ' + l)) }

async function main() {
  console.log('AFIP-S4B-2C — concurrencia de finalización\n')

  // ── A: misma idempotency key ──
  await reset()
  let states = await Promise.all(Array.from({ length: N }, () => psql(finalize('race-same'))
    .then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60))))
  console.log('A estados:', JSON.stringify(states))
  let s = await estado()
  check(states.filter((x) => x === 'ROTATION_COMPLETED').length === 1, 'A: exactamente 1 ROTATION_COMPLETED')
  check(states.filter((x) => x === 'ROTATION_ALREADY_COMPLETED').length === N - 1, `A: ${N - 1} ROTATION_ALREADY_COMPLETED`)
  check(s.st === 'completed', 'A: rotación en completed')
  check(s.terminales === 1, 'A: un solo evento terminal auditado')
  check(s.finalizados === 1, 'A: una sola transición efectiva')
  check(s.fp === PENDING_FP && s.secretos === 2, 'A: par activo y ambos secretos intactos')
  check(await parCoherente(), 'A: par clave/certificado coherente')

  // ── B: idempotency keys distintas ──
  await reset()
  states = await Promise.all(Array.from({ length: N }, (_, i) => psql(finalize('race-diff-' + i))
    .then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60))))
  console.log('B estados:', JSON.stringify(states))
  s = await estado()
  check(states.filter((x) => x === 'ROTATION_COMPLETED').length === 1, 'B: una sola finalización efectiva')
  check(states.every((x) => x === 'ROTATION_COMPLETED' || x === 'ROTATION_ALREADY_COMPLETED'),
    'B: el resto responde ya completada, sin errores')
  check(s.st === 'completed' && s.terminales === 1, 'B: estado final correcto, un solo evento terminal')
  check(s.fp === PENDING_FP && s.secretos === 2, 'B: sin corrupción del par activo ni de los secretos')
  check(await parCoherente(), 'B: par clave/certificado coherente')

  // ── C: finalización y rollback concurrentes ──
  await reset()
  const mixed = await Promise.all([
    psql(finalize('race-mix')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(rollback('race-mix-rb')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(finalize('race-mix')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
    psql(rollback('race-mix-rb')).then(last).catch((e) => 'EXC:' + String(e.message).slice(0, 60)),
  ])
  console.log('C estados:', JSON.stringify(mixed))
  s = await estado()
  check(!mixed.some((x) => String(x).startsWith('EXC:')), 'C: ninguna operación lanzó excepción')
  check(await parCoherente(), 'C: NUNCA un par cruzado (clave y certificado siempre coherentes)')
  check(['completed', 'rolled_back'].includes(s.st), `C: estado final determinista (${s.st})`)
  check((s.st === 'completed' && s.fp === PENDING_FP) || (s.st === 'rolled_back' && s.fp === ACTIVE_FP),
    'C: el fingerprint activo corresponde al estado final')
  check(s.secretos === 2, 'C: ningún secreto se borró')
  check(s.terminales <= 1, 'C: como mucho un evento terminal')

  // Los harness de S4A/S4B-2A cuentan pendings, secretos y eventos SIN filtrar
  // por negocio. Este harness limpia lo suyo para no contaminarlos si corre antes.
  await psql(`
    DELETE FROM private.arca_credential_audit WHERE business_id='${BIZ}';
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM vault.secrets WHERE name LIKE '%${BIZ}%';
    DELETE FROM private.arca_private_key_credentials WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';`)

  console.log(fail === 0 ? '\nTODO OK' : `\n${fail} FALLAS`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
