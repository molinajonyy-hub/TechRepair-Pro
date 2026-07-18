#!/usr/bin/env node
// ============================================================================
// M7 7E.2 — Ensayo del camino de upgrade REAL (a1791e1 -> HEAD).
//
// Un `db reset` prueba la instalación limpia, no el upgrade. Producción no se
// reconstruye desde cero: parte de datos que ya existen, y el riesgo está justo
// ahí — una constraint que no valida contra filas históricas, un índice único
// sobre datos que ya tienen duplicados, una migración que asume el seed nuevo.
//
// Este script:
//   1. aparta las migraciones M7 y reconstruye la base SOLO con las de a1791e1;
//   2. siembra fixtures representativos PRE-M7 (incluye los casos feos);
//   3. toma conteos y sumas económicas;
//   4. aplica las migraciones M7 UNA POR UNA, midiendo tiempo y locks;
//   5. vuelve a medir y compara;
//   6. restaura siempre las migraciones (finally), pase lo que pase.
//
// Sólo habla con el contenedor local. No puede tocar producción.
//
//   node scripts/finance/upgrade-rehearsal.mjs
// ============================================================================
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MIGR_DIR = 'supabase/migrations'
const PARK_DIR = '.rehearsal-parked'
// Frontera exacta: todo lo posterior a la última migración de origin/main.
const ULTIMA_PRODUCTIVA = '20260706180000_m6_rls_lockdown.sql'

function cont() {
  const toml = readFileSync('supabase/config.toml', 'utf-8')
  const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)
  return `supabase_db_${m[1]}`
}
function psql(sql) {
  return execFileSync('docker',
    ['exec', '-i', cont(), 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
     '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf-8' }).trim()
}
function psqlFile(path) {
  return execSync(
    `docker exec -i ${cont()} psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "${path}"`,
    { encoding: 'utf-8', shell: 'cmd.exe' })
}
const num = q => Number(psql(q) || 0)

// ─── Fixtures PRE-M7 ────────────────────────────────────────────────────────
// Representan lo que YA existe en producción, incluidos los casos que las
// migraciones M7 podrían no tolerar.
const BIZ  = '00000000-0000-0000-0000-00007e200001'
const BIZ2 = '00000000-0000-0000-0000-00007e200002'
const U1   = '00000000-0000-0000-0000-00007e200009'
const U2   = '00000000-0000-0000-0000-00007e200008'

const SEED_PRE_M7 = `
BEGIN;
SET LOCAL session_replication_role='replica';

INSERT INTO auth.users(id) VALUES ('${U1}'),('${U2}');
INSERT INTO businesses(id,name,owner_user_id) VALUES
  ('${BIZ}','Rehearsal A','${U1}'), ('${BIZ2}','Rehearsal B','${U2}');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  ('${BIZ}','${U1}','owner',true), ('${BIZ2}','${U2}','owner',true);

-- Categorías de gasto con los casos que rompen un UNIQUE ingenuo:
-- duplicado exacto, diferencia de mayúsculas, y espacios alrededor.
INSERT INTO expense_categories(id,business_id,name,color,sort_order) VALUES
  ('00000000-0000-0000-0000-00007e20c001','${BIZ}','Operativos','#111',1),
  ('00000000-0000-0000-0000-00007e20c002','${BIZ}','Operativos','#222',2),
  ('00000000-0000-0000-0000-00007e20c003','${BIZ}','OPERATIVOS','#333',3),
  ('00000000-0000-0000-0000-00007e20c004','${BIZ}','  Operativos  ','#444',4),
  ('00000000-0000-0000-0000-00007e20c005','${BIZ}','Marketing propio','#555',5),
  -- mismo nombre en OTRO negocio: no debe fusionarse jamás
  ('00000000-0000-0000-0000-00007e20c006','${BIZ2}','Operativos','#666',1);

-- Un gasto que REFERENCIA una de las categorías duplicadas: el dedupe no puede
-- dejar la FK colgando.
INSERT INTO business_finance_entries(id,business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate)
  VALUES ('00000000-0000-0000-0000-00007e20b001','${BIZ}','2026-05-10','fixed_cost_local','Operativos','gasto historico',2000,'ARS',2000,1);
INSERT INTO expenses(id,description,category,amount,amount_ars,date,business_id,finance_entry_id)
  VALUES ('00000000-0000-0000-0000-00007e20e001','gasto historico','Operativos',2000,2000,'2026-05-10','${BIZ}','00000000-0000-0000-0000-00007e20b001');

-- Comprobantes: emitido, anulado normal, y DOS anulados SIN registro canónico
-- (el patrón del blocker 7A).
INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date) VALUES
  ('00000000-0000-0000-0000-00007e20f001','factura_c','0001-00000001','emitido','no_fiscal',10000,10000,10000,0,'${BIZ}','${U1}','0001','2026-05-02','2026-05-02'),
  ('00000000-0000-0000-0000-00007e20f002','factura_c','0001-00000002','anulado','no_fiscal',5000,5000,0,0,'${BIZ}','${U1}','0001','2026-05-03','2026-05-03'),
  ('00000000-0000-0000-0000-00007e20f003','factura_c','0001-00000003','anulado','no_fiscal',80000,80000,80000,0,'${BIZ}','${U1}','0001','2026-05-04','2026-05-04'),
  ('00000000-0000-0000-0000-00007e20f004','factura_c','0001-00000004','anulado','no_fiscal',69438,69438,69438,0,'${BIZ}','${U1}','0001','2026-05-05','2026-05-05');

-- Cobros: uno simple, uno MIXTO (dos filas) — el mixto es el que rompe un
-- índice único mal puesto sobre financial_movements.
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by) VALUES
  ('00000000-0000-0000-0000-00007e20f001','${BIZ}',10000,'ARS',10000,1,'efectivo',0,'2026-05-02','${U1}'),
  ('00000000-0000-0000-0000-00007e20f003','${BIZ}',50000,'ARS',50000,1,'efectivo',0,'2026-05-04','${U1}'),
  ('00000000-0000-0000-0000-00007e20f003','${BIZ}',30000,'ARS',30000,1,'tarjeta_credito',0,'2026-05-04','${U1}');

-- Movimientos financieros históricos (ingresos de esas ventas).
INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,comprobante_id,description,created_by,sign) VALUES
  ('${BIZ}','2026-05-02','income','ARS',10000,10000,1,'comprobante','00000000-0000-0000-0000-00007e20f001','venta 1','${U1}',1),
  ('${BIZ}','2026-05-04','income','ARS',80000,80000,1,'comprobante','00000000-0000-0000-0000-00007e20f003','venta 3','${U1}',1),
  ('${BIZ}','2026-05-05','income','ARS',69438,69438,1,'comprobante','00000000-0000-0000-0000-00007e20f004','venta 4','${U1}',1);

-- Proveedor con compra y pago.
INSERT INTO suppliers(id,business_id,name) VALUES ('00000000-0000-0000-0000-00007e20d001','${BIZ}','Proveedor Rehearsal');
INSERT INTO supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount)
  VALUES ('00000000-0000-0000-0000-00007e20d002','${BIZ}','00000000-0000-0000-0000-00007e20d001','2026-05-06',15000,5000);

-- Caja cerrada (histórica) y caja abierta (actual).
INSERT INTO cajas(id,business_id,opened_by,status,opened_at) VALUES
  ('00000000-0000-0000-0000-00007e20a001','${BIZ}','${U1}','cerrada','2026-05-01'),
  ('00000000-0000-0000-0000-00007e20a002','${BIZ}','${U1}','abierta',now());

SET LOCAL session_replication_role='origin';
COMMIT;
`

// Sumas económicas que NO deben moverse por una migración de esquema.
const METRICAS = {
  comprobantes:        `SELECT count(*) FROM comprobantes`,
  comprobantes_anul:   `SELECT count(*) FROM comprobantes WHERE estado='anulado'`,
  pagos:               `SELECT count(*) FROM comprobante_payments`,
  fm_filas:            `SELECT count(*) FROM financial_movements`,
  fm_suma_ars:         `SELECT COALESCE(SUM(amount_ars * COALESCE(sign,1)),0)::text FROM financial_movements`,
  bfe_filas:           `SELECT count(*) FROM business_finance_entries`,
  bfe_suma_ars:        `SELECT COALESCE(SUM(amount_ars),0)::text FROM business_finance_entries`,
  expenses:            `SELECT count(*) FROM expenses`,
  categorias:          `SELECT count(*) FROM expense_categories`,
  proveedores_compras: `SELECT count(*) FROM supplier_purchases`,
  compras_pagado:      `SELECT COALESCE(SUM(paid_amount),0)::text FROM supplier_purchases`,
  cajas:               `SELECT count(*) FROM cajas`,
  cajas_abiertas:      `SELECT count(*) FROM cajas WHERE status='abierta'`,
}

function medir() {
  const out = {}
  for (const [k, q] of Object.entries(METRICAS)) out[k] = psql(q)
  return out
}

function migracionesM7() {
  return readdirSync(MIGR_DIR).filter(f => f.endsWith('.sql') && f > ULTIMA_PRODUCTIVA).sort()
}

const resultados = []
function chk(nombre, ok, detalle) {
  resultados.push({ nombre, ok, detalle })
  console.log(`${ok ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

async function main() {
  const m7 = migracionesM7()
  console.log(`── M7 7E.2 · ensayo de upgrade ────────────────────────────────`)
  console.log(`Migraciones M7 a aplicar incrementalmente: ${m7.length}\n`)

  if (existsSync(PARK_DIR)) rmSync(PARK_DIR, { recursive: true, force: true })
  mkdirSync(PARK_DIR, { recursive: true })

  try {
    // ── 1. Base PRE-M7 ──────────────────────────────────────────────────────
    for (const f of m7) renameSync(join(MIGR_DIR, f), join(PARK_DIR, f))
    console.log(`→ apartadas ${m7.length} migraciones M7; reconstruyendo base a1791e1...`)
    execSync('npx supabase db reset', { stdio: 'pipe', shell: 'cmd.exe' })

    const m7Presentes = num(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version > '20260706180000'`)
    chk('BASE-1 la base quedó SIN migraciones M7', m7Presentes === 0, `M7 aplicadas=${m7Presentes}`)

    // ── 2. Fixtures pre-M7 ──────────────────────────────────────────────────
    // Por archivo, NO aplanado a una línea: el seed tiene comentarios `--`, y
    // colapsar los saltos de línea convierte el primero en un comentario que se
    // come todo el resto. Pasó: el seed no insertaba nada y las comprobaciones
    // de datos daban verde sobre tablas vacías.
    const seedPath = join(tmpdir(), 'm7-rehearsal-seed.sql')
    writeFileSync(seedPath, SEED_PRE_M7, 'utf-8')
    psqlFile(seedPath)
    const antes = medir()
    console.log('\n→ estado PRE-upgrade:')
    for (const [k, v] of Object.entries(antes)) console.log(`     ${k.padEnd(22)} ${v}`)

    chk('BASE-2 hay categorias duplicadas antes del upgrade',
      Number(antes.categorias) === 6, `categorias=${antes.categorias}`)
    chk('BASE-3 hay un cobro MIXTO (2 pagos en un comprobante)',
      num(`SELECT count(*) FROM comprobante_payments WHERE comprobante_id='00000000-0000-0000-0000-00007e20f003'`) === 2)

    // ── 3. Upgrade incremental, midiendo ────────────────────────────────────
    console.log('\n→ aplicando migraciones M7 una por una:\n')
    const tiempos = []
    for (const f of m7) {
      const t0 = Date.now()
      try {
        psqlFile(join(PARK_DIR, f))
      } catch (e) {
        chk(`MIGR ${f}`, false, (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' | '))
        throw new Error(`La migración ${f} falló sobre datos preexistentes`)
      }
      const ms = Date.now() - t0
      tiempos.push({ f, ms })
      const lenta = ms > 5000
      console.log(`   ${lenta ? '⚠️ ' : '   '}${String(ms).padStart(6)} ms  ${f}`)
    }
    const total = tiempos.reduce((s, t) => s + t.ms, 0)
    const masLenta = tiempos.slice().sort((a, b) => b.ms - a.ms)[0]
    console.log(`\n   total ${total} ms · más lenta: ${masLenta.f} (${masLenta.ms} ms)`)
    chk('UPG-1 todas las migraciones M7 aplican sobre datos preexistentes', true, `${m7.length} migraciones, ${total} ms`)
    chk('UPG-2 ninguna migración supera 5 s en este dataset', masLenta.ms <= 5000, `${masLenta.ms} ms`)

    // ── 4. Los datos sobrevivieron ──────────────────────────────────────────
    const despues = medir()
    console.log('\n→ estado POST-upgrade:')
    for (const [k, v] of Object.entries(despues)) {
      const cambio = antes[k] !== v ? `   (antes ${antes[k]})` : ''
      console.log(`     ${k.padEnd(22)} ${v}${cambio}`)
    }

    // Lo económico NO puede moverse por un cambio de esquema.
    for (const k of ['comprobantes','comprobantes_anul','pagos','fm_filas','fm_suma_ars',
                     'bfe_filas','bfe_suma_ars','expenses','proveedores_compras',
                     'compras_pagado','cajas','cajas_abiertas']) {
      chk(`DATA ${k} intacto`, antes[k] === despues[k], `${antes[k]} -> ${despues[k]}`)
    }

    // Las categorías SÍ deben bajar: es el dedupe deliberado de 7E.1b.
    chk('DEDUP-1 las categorias duplicadas se fusionaron',
      Number(despues.categorias) < Number(antes.categorias),
      `${antes.categorias} -> ${despues.categorias}`)
    chk('DEDUP-2 el otro negocio conserva SU categoria homonima',
      num(`SELECT count(*) FROM expense_categories WHERE business_id='${BIZ2}'`) === 1)
    chk('DEDUP-3 la categoria personalizada sobrevive',
      num(`SELECT count(*) FROM expense_categories WHERE business_id='${BIZ}' AND name='Marketing propio'`) === 1)
    chk('DEDUP-4 queda UNA sola variante de "Operativos" en el negocio A',
      num(`SELECT count(*) FROM expense_categories WHERE business_id='${BIZ}' AND lower(btrim(name))='operativos'`) === 1)
    chk('DEDUP-5 el indice unico existe tras el dedupe',
      num(`SELECT count(*) FROM pg_indexes WHERE indexname='uniq_expense_categories_business_name'`) === 1)
    chk('DEDUP-6 el gasto que referenciaba la categoria sigue existiendo',
      num(`SELECT count(*) FROM expenses WHERE id='00000000-0000-0000-0000-00007e20e001'`) === 1)

    // ── 5. Seguridad en el camino de UPGRADE (no sólo en instalación limpia) ─
    for (const rol of ['anon','authenticated','service_role','authenticator']) {
      chk(`SEC ${rol} sin CREATE sobre public tras el upgrade`,
        psql(`SELECT has_schema_privilege('${rol}','public','CREATE')`) === 'f')
    }
    chk('SEC postgres conserva CREATE (migraciones futuras)',
      psql(`SELECT has_schema_privilege('postgres','public','CREATE')`) === 't')

    // ── 6. El cobro mixto sigue siendo anulable ─────────────────────────────
    chk('MIX-1 el comprobante con cobro mixto conserva sus 2 pagos',
      num(`SELECT count(*) FROM comprobante_payments WHERE comprobante_id='00000000-0000-0000-0000-00007e20f003'`) === 2)

    // ── 7. Anomalías 7A visibles tras el upgrade ────────────────────────────
    const anom = num(`SELECT count(*) FROM comprobantes c
      WHERE c.estado='anulado'
        AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id)`)
    chk('7A-1 las anulaciones sin registro canonico quedan detectables', anom >= 1, `detectadas=${anom}`)

  } finally {
    // Pase lo que pase, las migraciones vuelven a su lugar.
    if (existsSync(PARK_DIR)) {
      for (const f of readdirSync(PARK_DIR)) renameSync(join(PARK_DIR, f), join(MIGR_DIR, f))
      rmSync(PARK_DIR, { recursive: true, force: true })
      console.log('\n→ migraciones M7 restauradas en supabase/migrations')
    }
  }

  console.log('\n──────────────────────────────────────────────────────────────')
  const fallos = resultados.filter(r => !r.ok)
  console.log(`${resultados.length - fallos.length}/${resultados.length} verificaciones OK`)
  if (fallos.length) { console.log('\nFALLAN:'); fallos.forEach(f => console.log(`  ❌ ${f.nombre} (${f.detalle ?? ''})`)) }
  process.exit(fallos.length ? 1 : 0)
}

main().catch(e => { console.error('\nREHEARSAL ERROR:', e.message); process.exit(2) })
