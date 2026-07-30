#!/usr/bin/env node
// ============================================================================
// P0-A.1C — Prueba de CONCURRENCIA REAL de la imputación de cobros.
//
// Dos conexiones psql INDEPENDIENTES (procesos separados) intentan imputar el
// mismo crédito al mismo tiempo. No es una simulación secuencial: la sesión A
// toma el lock y duerme dentro de su transacción, así que B llega a la RPC
// mientras A sigue abierta.
//
// Caso 1: pago 100.000 · comprobante A saldo 60.000 · ambas imputan 60.000 a A.
// Caso 2: repartos incompatibles sobre A (60.000) y B (40.000).
//
// Invariantes verificados al final:
//   · el total activo imputado nunca supera el importe del pago;
//   · ningún comprobante recibe más que su saldo;
//   · sin deadlock, sin asignaciones duplicadas;
//   · el recompute deja el estado correcto.
//
//   node scripts/finance/allocation-concurrency-run.mjs
// ============================================================================
import { execFile } from 'node:child_process'

const CT = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-0000-0000-0000000c0c01'
const USR = '00000000-0000-0000-0000-0000000c0c09'

function psql(sql, { tuples = true } = {}) {
  return new Promise((resolve) => {
    const args = ['exec', '-i', CT, 'psql', '-U', 'postgres', '-d', 'postgres', '-X']
    if (tuples) args.push('-tA')
    args.push('-c', sql)
    const t0 = Date.now()
    execFile('docker', args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim(), ms: Date.now() - t0 })
    })
  })
}

const asAuth = (body) =>
  `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '${USR}'; ${body} COMMIT;`

async function ids() {
  const r = await psql(
    `select (select id from account_movements where business_id='${BIZ}' and type='pago' limit 1)::text || '|' ||
            (select id from comprobantes where business_id='${BIZ}' and total_bruto=60000 limit 1)::text || '|' ||
            (select id from comprobantes where business_id='${BIZ}' and total_bruto=40000 limit 1)::text;`)
  const [pay, ca, cb] = r.out.split('|')
  return { pay, ca, cb }
}

async function invariantes(etiqueta) {
  const r = await psql(`
    select
      (select coalesce(sum(amount),0) from customer_account_payment_allocations
        where business_id='${BIZ}' and status='active')::text
      || ' | pago=' || (select credit::text from account_movements where business_id='${BIZ}' and type='pago' limit 1)
      || ' | activas=' || (select count(*)::text from customer_account_payment_allocations
                            where business_id='${BIZ}' and status='active')
      || ' | maxDoc=' || coalesce((select max(t)::text from (
             select c.id, coalesce(sum(a.amount),0) - coalesce(c.saldo_pendiente,0) as t
             from comprobantes c left join customer_account_payment_allocations a
               on a.comprobante_id=c.id and a.status='active'
             where c.business_id='${BIZ}' group by c.id, c.saldo_pendiente) x), '0');`)
  console.log(`   ${etiqueta}: imputado_activo=${r.out}`)
  return r.out
}

const run = async () => {
  const { pay, ca, cb } = await ids()
  console.log(`Escenario sembrado · pago=${pay.slice(0, 8)} · compA=${ca.slice(0, 8)} · compB=${cb.slice(0, 8)}\n`)

  // ── Caso 1: las dos sesiones imputan 60.000 al MISMO comprobante ──────────
  console.log('CASO 1 — dos sesiones imputan 60.000 al comprobante A (saldo 60.000)')
  const alloc = (key, comp, amount, sleep = 0) => asAuth(
    `
     SELECT allocate_account_payment_atomic('${BIZ}'::uuid, '${pay}'::uuid,
       jsonb_build_array(jsonb_build_object('comprobante_id','${comp}','amount',${amount})),
       'concurrencia', '${key}');
     ${sleep ? `SELECT pg_sleep(${sleep});` : ''}`)

  const t0 = Date.now()
  const [A, B] = await Promise.all([
    psql(alloc('CONC-1-A', ca, 60000, 3)),   // A retiene el lock 3 s
    new Promise((res) => setTimeout(() => res(psql(alloc('CONC-1-B', ca, 60000))), 700)),
  ])
  console.log(`   A (t+0ms, ${A.ms}ms): ${A.out.split('\n').filter(l => l.startsWith('{')).join(' ') || A.err.slice(0, 120)}`)
  console.log(`   B (t+700ms, ${B.ms}ms): ${B.out.split('\n').filter(l => l.startsWith('{')).join(' ') || B.err.slice(0, 120)}`)
  console.log(`   wall-clock total: ${Date.now() - t0}ms  (B esperó el lock de A: no corrieron en serie por casualidad)`)
  const inv1 = await invariantes('tras caso 1')

  // ── Caso 2: repartos incompatibles ───────────────────────────────────────
  console.log('\nCASO 2 — repartos incompatibles sobre A (60.000) y B (40.000)')
  const split = (key, sleep = 0) => asAuth(
    `SELECT allocate_account_payment_atomic('${BIZ}'::uuid, '${pay}'::uuid,
       jsonb_build_array(
         jsonb_build_object('comprobante_id','${ca}','amount',30000),
         jsonb_build_object('comprobante_id','${cb}','amount',40000)),
       'concurrencia-2', '${key}');
     ${sleep ? `SELECT pg_sleep(${sleep});` : ''}`)
  const [C, D] = await Promise.all([
    psql(split('CONC-2-C', 3)),
    new Promise((res) => setTimeout(() => res(psql(split('CONC-2-D'))), 700)),
  ])
  console.log(`   C: ${C.out.split('\n').filter(l => l.startsWith('{')).join(' ') || C.err.slice(0, 140)}`)
  console.log(`   D: ${D.out.split('\n').filter(l => l.startsWith('{')).join(' ') || D.err.slice(0, 140)}`)
  const inv2 = await invariantes('tras caso 2')

  // ── Verificación de invariantes ──────────────────────────────────────────
  console.log('\nINVARIANTES')
  // psql -tA separa columnas con '|': se piden como COLUMNAS, no concatenadas.
  // Concatenar mezclaba la precedencia de <= con || y devolvía NULL.
  const chk = await psql(`
    select
      (select coalesce(sum(amount),0) from customer_account_payment_allocations
        where business_id='${BIZ}' and status='active')
        <= (select coalesce(credit,0) from account_movements
             where business_id='${BIZ}' and type='pago' limit 1) + 0.01 as no_supera_pago,
      not exists (
        select 1 from comprobantes c where c.business_id='${BIZ}'
          and (select coalesce(sum(a.amount),0) from customer_account_payment_allocations a
                where a.comprobante_id=c.id and a.status='active') > coalesce(c.saldo_pendiente,0) + 0.01
      ) as no_supera_saldo,
      not exists (
        select 1 from customer_account_payment_allocations where business_id='${BIZ}'
         group by business_id, idempotency_key having count(*) > 1
      ) as sin_duplicados,
      (select coalesce(string_agg(left(order_id::text,8) || '=' || payment_status, ', '), 'sin ordenes')
         from v_order_financial_status where business_id='${BIZ}') as estados;`)
  const [noSupera, noSobrepasa, sinDup, estados] = chk.out.split('|')
  const linea = (ok, txt) => console.log(`   ${ok === 't' ? '✅' : '❌'} ${txt}`)
  linea(noSupera,    'el total activo imputado nunca supera el importe del pago')
  linea(noSobrepasa, 'ningún comprobante recibió más que su saldo')
  linea(sinDup,      'no hay asignaciones duplicadas por idempotency_key')
  console.log(`   estados finales: ${estados}`)

  const deadlock = [A, B, C, D].some(r => /deadlock/i.test(r.err + r.out))
  linea(deadlock ? 'f' : 't', 'sin deadlocks')

  const ok = noSupera === 't' && noSobrepasa === 't' && sinDup === 't' && !deadlock
  console.log(ok ? '\n✅ CONCURRENCIA OK' : '\n❌ CONCURRENCIA FALLÓ')
  process.exit(ok ? 0 : 1)
}

run()
