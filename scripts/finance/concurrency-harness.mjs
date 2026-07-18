#!/usr/bin/env node
// ============================================================================
// M7 7E.1b — Harness de concurrencia REAL contra el Postgres local.
//
// El pliego (§12) exige dos sesiones de verdad, no dos llamadas secuenciales.
// La diferencia importa: un `SELECT ... IF NOT FOUND THEN INSERT` es correcto
// en secuencia y puede estar roto en paralelo, porque en READ COMMITTED la
// sesión B NO ve la fila que A todavía no commiteó. Ese es exactamente el
// agujero que hay que poder demostrar o descartar.
//
// No usa sleeps para "ganar" la carrera: mantiene DOS transacciones abiertas y
// ordena los pasos a mano, así el solapamiento es determinista y el resultado
// reproducible.
//
//   node scripts/finance/concurrency-harness.mjs
//
// Sólo habla con el contenedor local por `docker exec`: estructuralmente no
// puede tocar producción.
// ============================================================================
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function contenedor() {
  const toml = readFileSync('supabase/config.toml', 'utf-8')
  const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error('supabase/config.toml no declara project_id')
  const nombre = `supabase_db_${m[1]}`
  const ps = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' })
  if (!ps.split('\n').map(s => s.trim()).includes(nombre)) {
    throw new Error(`El contenedor "${nombre}" no está corriendo (npx supabase start).`)
  }
  return nombre
}

/** Una sesión psql persistente: se le mandan comandos y se lee la salida. */
class Sesion {
  constructor(nombre, cont) {
    this.nombre = nombre
    this.buffer = ''
    this.proc = spawn('docker',
      ['exec', '-i', cont, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres',
       '-v', 'ON_ERROR_STOP=0', '--no-align', '--tuples-only'],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', d => { this.buffer += d.toString() })
    this.proc.stderr.on('data', d => { this.buffer += d.toString() })
  }

  /** Ejecuta SQL y espera a que aparezca un centinela, sin dormir a ciegas. */
  async run(sql) {
    const marca = `__FIN_${Math.abs(hash(sql + this.nombre))}__`
    this.buffer = ''
    this.proc.stdin.write(`${sql}\nSELECT '${marca}';\n`)
    const t0 = Date.now()
    while (!this.buffer.includes(marca)) {
      if (Date.now() - t0 > 20000) throw new Error(`timeout en ${this.nombre}: ${sql.slice(0, 80)}`)
      await new Promise(r => setTimeout(r, 25))
    }
    return this.buffer.split(marca)[0].trim()
  }

  /** Manda SQL SIN esperar: para dejar una sesión bloqueada a propósito. */
  enviar(sql) { this.buffer = ''; this.proc.stdin.write(sql + '\n') }

  /**
   * Resultado jsonb de la RPC, o null si todavía no llegó.
   * Mirar "buffer vacío" no sirve: arrastra la salida de los SET/set_config
   * previos y daría por respondida una sesión que en realidad está bloqueada.
   */
  resultadoRPC() {
    const m = this.buffer.match(/\{.*\}/s)
    return m ? m[0] : null
  }

  async cerrar() { this.proc.stdin.end(); this.proc.kill() }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 } return h }

function sql1(q) {
  return execFileSync('docker',
    ['exec', '-i', contenedor(), 'psql', '-X', '-q', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', q],
    { encoding: 'utf-8' }).trim()
}

const resultados = []
function chequear(nombre, ok, detalle) {
  resultados.push({ nombre, ok, detalle })
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

// ─── Fixture ────────────────────────────────────────────────────────────────
const BIZ  = '00000000-0000-0000-0000-0000007e1b01'
const USER = '00000000-0000-0000-0000-0000007e1b09'
const ORIG = '00000000-0000-0000-0000-0000007e1bc1'
const NC   = '00000000-0000-0000-0000-0000007e1bc2'

function sembrar() {
  sql1(`
BEGIN;
SET LOCAL session_replication_role='replica';
DELETE FROM public.financial_movements WHERE business_id='${BIZ}';
DELETE FROM public.business_finance_entries WHERE business_id='${BIZ}';
DELETE FROM public.comprobantes WHERE business_id='${BIZ}';
DELETE FROM public.profiles WHERE business_id='${BIZ}';
DELETE FROM public.businesses WHERE id='${BIZ}';
DELETE FROM auth.users WHERE id='${USER}';
INSERT INTO auth.users(id) VALUES ('${USER}');
INSERT INTO public.businesses(id,name,owner_user_id) VALUES ('${BIZ}','7E1b','${USER}');
INSERT INTO public.profiles(business_id,user_id,role,is_active) VALUES ('${BIZ}','${USER}','owner',true);
INSERT INTO public.comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date)
  VALUES ('${ORIG}','factura_c','0001-7E1B01','emitido','emitido',1000,1000,0,1000,'${BIZ}','${USER}','0001',now(),now());
INSERT INTO public.comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date,comprobante_original_id)
  VALUES ('${NC}','nota_credito','0001-7E1B02','emitido','emitido',1000,1000,0,0,'${BIZ}','${USER}','0001',now(),now(),'${ORIG}');
SET LOCAL session_replication_role='origin';
COMMIT;`)
}

function limpiarEfectos() {
  sql1(`BEGIN; SET LOCAL session_replication_role='replica';
        DELETE FROM public.financial_movements WHERE comprobante_id='${NC}';
        DELETE FROM public.business_finance_entries WHERE reference_comprobante_id='${NC}';
        COMMIT;`)
}

const contarFM  = () => Number(sql1(`SELECT count(*) FROM public.financial_movements WHERE comprobante_id='${NC}' AND sign=-1`))
const contarBFE = () => Number(sql1(`SELECT count(*) FROM public.business_finance_entries WHERE reference_comprobante_id='${NC}' AND amount<0`))

const COMO_USUARIO = `SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','${USER}',true);
SELECT set_config('request.jwt.claims','{"sub":"${USER}","role":"authenticated"}',true);`

async function main() {
  const cont = contenedor()
  console.log('── M7 7E.1b · concurrencia real ──────────────────────────────\n')
  sembrar()

  // ══ ESCENARIO 1: create_credit_note_finance_reversal en paralelo ══════════
  // Dos transacciones solapadas. B corre su chequeo ANTES de que A commitee,
  // asi que no puede ver la fila de A. Sin constraint, las dos insertan.
  limpiarEfectos()
  {
    const A = new Sesion('A', cont), B = new Sesion('B', cont)
    await A.run('BEGIN;'); await B.run('BEGIN;')
    await A.run(COMO_USUARIO); await B.run(COMO_USUARIO)

    const rA = await A.run(`SELECT public.create_credit_note_finance_reversal('${NC}');`)

    // B se lanza con A TODAVIA sin commitear. Su SELECT de control no puede ver
    // la fila de A (READ COMMITTED), asi que pasa el chequeo e intenta insertar.
    // No se espera la respuesta: si algo la serializa, B queda bloqueada aca.
    B.enviar(`SELECT public.create_credit_note_finance_reversal('${NC}');`)
    await new Promise(r => setTimeout(r, 900))
    const pendiente = B.resultadoRPC()
    chequear('NC-C0 la segunda sesion queda BLOQUEADA antes de duplicar',
      pendiente === null, pendiente === null ? 'espera a que A resuelva' : `no se bloqueo: ${pendiente.slice(0,70)}`)

    await A.run('COMMIT;')                     // A confirma: B se destraba aca
    await new Promise(r => setTimeout(r, 900))
    const rB = B.resultadoRPC() ?? '(sin resultado)'
    await B.run('COMMIT;')
    await A.cerrar(); await B.cerrar()

    const fm = contarFM(), bfe = contarBFE()
    chequear('NC-C1 un solo financial_movement tras dos llamadas concurrentes', fm === 1, `FM=${fm}`)
    chequear('NC-C2 un solo business_finance_entry tras dos llamadas concurrentes', bfe === 1, `BFE=${bfe}`)
    // 7E.1b: la perdedora ya no filtra el texto de la constraint. Devuelve un
    // REPLAY, que es lo correcto: el estado final deseado se cumplio igual.
    chequear('NC-C3 la perdedora devuelve replay tipado, sin filtrar SQL',
      /"replay": *true/.test(rB) && !/duplicate key|constraint/.test(rB),
      rB.replace(/\s+/g, ' ').slice(0, 95))
    console.log(`   A -> ${rA.split('\n')[0].slice(0, 90)}`)
  }

  // ══ ESCENARIO 2: replay secuencial (debe ser seguro) ══════════════════════
  limpiarEfectos()
  {
    const A = new Sesion('A', cont)
    await A.run('BEGIN;'); await A.run(COMO_USUARIO)
    await A.run(`SELECT public.create_credit_note_finance_reversal('${NC}');`)
    await A.run('COMMIT;')
    await A.run('BEGIN;'); await A.run(COMO_USUARIO)
    const r2 = await A.run(`SELECT public.create_credit_note_finance_reversal('${NC}');`)
    await A.run('COMMIT;'); await A.cerrar()
    const fm = contarFM(), bfe = contarBFE()
    chequear('NC-S1 replay secuencial no duplica FM', fm === 1, `FM=${fm}`)
    chequear('NC-S2 replay secuencial no duplica BFE', bfe === 1, `BFE=${bfe}`)
    chequear('NC-S3 el replay informa que no creo nada nuevo',
      /"fm_created" *: *false|fm_created.*false/.test(r2), r2.split('\n')[0].slice(0, 90))
  }

  // ══ ESCENARIO 3: delete_supplier_purchase_safe — el FOR UPDATE serializa ══
  {
    const PUR = '00000000-0000-0000-0000-0000007e1bd1'
    const SUP = '00000000-0000-0000-0000-0000007e1bd2'
    sql1(`BEGIN; SET LOCAL session_replication_role='replica';
      DELETE FROM public.supplier_purchase_items WHERE purchase_id='${PUR}';
      DELETE FROM public.supplier_purchases WHERE id='${PUR}';
      DELETE FROM public.suppliers WHERE id='${SUP}';
      INSERT INTO public.suppliers(id,business_id,name) VALUES ('${SUP}','${BIZ}','Prov 7E1b');
      INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount)
        VALUES ('${PUR}','${BIZ}','${SUP}',current_date,500,0);
      COMMIT;`)

    const A = new Sesion('A', cont), B = new Sesion('B', cont)
    await A.run('BEGIN;'); await A.run(COMO_USUARIO)
    await A.run(`SELECT public.delete_supplier_purchase_safe('${BIZ}','${PUR}','${USER}');`)
    // B se lanza SIN esperar: debe quedar bloqueada en el FOR UPDATE de A.
    await B.run('BEGIN;'); await B.run(COMO_USUARIO)
    B.enviar(`SELECT public.delete_supplier_purchase_safe('${BIZ}','${PUR}','${USER}');`)
    await new Promise(r => setTimeout(r, 800))
    const pendienteDel = B.resultadoRPC()
    const bloqueada = pendienteDel === null
    await A.run('COMMIT;')
    await new Promise(r => setTimeout(r, 800))
    const rB = B.resultadoRPC() ?? '(sin resultado)'
    await B.run('COMMIT;')
    await A.cerrar(); await B.cerrar()

    const quedan = Number(sql1(`SELECT count(*) FROM public.supplier_purchases WHERE id='${PUR}'`))
    const movs = Number(sql1(`SELECT count(*) FROM public.inventory_movements WHERE reference_id='${PUR}'`))
    chequear('DEL-C1 la segunda sesion queda BLOQUEADA por el FOR UPDATE', bloqueada, bloqueada ? 'espero a que A commitee' : 'NO se bloqueo')
    chequear('DEL-C2 la compra queda eliminada exactamente una vez', quedan === 0, `filas=${quedan}`)
    chequear('DEL-C3 el stock NO se revierte dos veces', movs <= 1, `inventory_movements=${movs}`)
    // 7E.1b: con tombstone, el retry ya no recibe "Compra no encontrada" (que se
    // lee como fallo) sino un replay explicito de algo que SI salio bien.
    chequear('DEL-C4 el retry recibe ALREADY_DELETED, no un error confuso',
      /ALREADY_DELETED/.test(rB) && /"replay": *true/.test(rB), rB.replace(/\s+/g, ' ').slice(0, 90))
  }

  // ══ ESCENARIO 4: pay_recurring_expense — mismo periodo, en paralelo ═══════
  {
    const EXP = '00000000-0000-0000-0000-0000007e1be1'
    const ACC = '00000000-0000-0000-0000-0000007e1be2'
    sql1(`BEGIN; SET LOCAL session_replication_role='replica';
      DELETE FROM public.personal_recurring_expense_payments WHERE recurring_expense_id='${EXP}';
      DELETE FROM public.personal_transactions WHERE account_id='${ACC}';
      DELETE FROM public.personal_recurring_expenses WHERE id='${EXP}';
      DELETE FROM public.personal_accounts WHERE id='${ACC}';
      INSERT INTO public.personal_accounts(id,user_id,name,type,currency,initial_balance,current_balance,is_active)
        VALUES ('${ACC}','${USER}','Caja 7E1b','cash','ARS',100000,100000,true);
      INSERT INTO public.personal_recurring_expenses(id,user_id,name,currency,amount,frequency,auto_create_transaction,status)
        VALUES ('${EXP}','${USER}','Alquiler 7E1b','ARS',5000,'monthly',false,'active');
      COMMIT;`)

    const A = new Sesion('A', cont), B = new Sesion('B', cont)
    await A.run('BEGIN;'); await A.run(COMO_USUARIO)
    await A.run(`SELECT public.pay_recurring_expense('${EXP}','${ACC}',5000,current_date,'7E1b');`)
    await B.run('BEGIN;'); await B.run(COMO_USUARIO)
    B.enviar(`SELECT public.pay_recurring_expense('${EXP}','${ACC}',5000,current_date,'7E1b');`)
    await new Promise(r => setTimeout(r, 900))
    const pend = B.resultadoRPC()
    await A.run('COMMIT;')
    await new Promise(r => setTimeout(r, 900))
    const rB = B.resultadoRPC() ?? '(sin resultado)'
    await B.run('COMMIT;'); await A.cerrar(); await B.cerrar()

    const pagos = Number(sql1(`SELECT count(*) FROM public.personal_recurring_expense_payments WHERE recurring_expense_id='${EXP}'`))
    const txs   = Number(sql1(`SELECT count(*) FROM public.personal_transactions WHERE account_id='${ACC}' AND type='expense'`))
    chequear('REC-C1 la segunda sesion queda BLOQUEADA por la constraint del periodo',
      pend === null, pend === null ? 'espera' : `no bloqueo: ${pend.slice(0,60)}`)
    chequear('REC-C2 un solo pago para el periodo', pagos === 1, `pagos=${pagos}`)
    chequear('REC-C3 una sola transaccion (sin doble debito)', txs === 1, `tx=${txs}`)
    chequear('REC-C4 la segunda llamada NO reporta exito', /false/.test(rB), rB.replace(/\s+/g,' ').slice(0, 95))
  }

  // ══ ESCENARIO 5: seed_expense_categories — §14 ═══════════════════════════
  // No tiene constraint UNIQUE(business_id,name): su `IF EXISTS ... RETURN` es
  // un check-then-insert sin red. Hay que ver si dos llamadas lo duplican.
  {
    // Se corre como `postgres`, sin SET ROLE: la pregunta es si la LOGICA
    // (check-then-insert) tolera el paralelismo, no si RLS deja pasar al
    // usuario. RLS es un control distinto y no impide que DOS usuarios
    // autorizados del mismo negocio corran esto a la vez, que es el caso real.
    sql1(`DELETE FROM public.expense_categories WHERE business_id='${BIZ}'`)
    const A = new Sesion('A', cont), B = new Sesion('B', cont)
    await A.run('BEGIN;'); await B.run('BEGIN;')
    await A.run(`SELECT public.seed_expense_categories('${BIZ}');`)
    // B corre con A sin commitear: su IF EXISTS no puede ver las filas de A, asi
    // que intenta insertar. Con el indice unico de 7E.1b queda BLOQUEADA ahi
    // (antes pasaba de largo y duplicaba las 7 categorias).
    // La funcion devuelve void: no hay jsonb que mirar. Se usa un centinela
    // explicito — si B estuviera bloqueada, el centinela no llega.
    B.enviar(`SELECT public.seed_expense_categories('${BIZ}'); SELECT 'SEED_LISTO';`)
    await new Promise(r => setTimeout(r, 900))
    const seedBloqueada = !B.buffer.includes('SEED_LISTO')
    chequear('SEED-C0 la segunda sesion queda BLOQUEADA por el indice unico',
      seedBloqueada, seedBloqueada ? 'espera a que A resuelva' : `no bloqueo: ${B.buffer.replace(/\s+/g,' ').slice(0,60)}`)
    await A.run('COMMIT;')
    await new Promise(r => setTimeout(r, 900))
    await B.run('COMMIT;')
    await A.cerrar(); await B.cerrar()

    const cats = Number(sql1(`SELECT count(*) FROM public.expense_categories WHERE business_id='${BIZ}'`))
    chequear('SEED-C1 no se duplican las categorias con dos llamadas concurrentes',
      cats === 7, `categorias=${cats} (esperado 7)`)
    sql1(`DELETE FROM public.expense_categories WHERE business_id='${BIZ}'`)
  }

  console.log('\n──────────────────────────────────────────────────────────────')
  const fallos = resultados.filter(r => !r.ok)
  console.log(`${resultados.length - fallos.length}/${resultados.length} verificaciones OK`)
  if (fallos.length) { console.log('\nFALLAN:'); fallos.forEach(f => console.log(`  ❌ ${f.nombre} (${f.detalle})`)) }
  process.exit(fallos.length ? 1 : 0)
}

main().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2) })
