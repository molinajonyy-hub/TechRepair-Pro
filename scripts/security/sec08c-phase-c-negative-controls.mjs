#!/usr/bin/env node
// SEC-08C FASE C — CONTROLES NEGATIVOS.
//
// Un test que nunca vio caer la frontera que dice proteger no prueba nada. Acá
// se rompe cada una A PROPOSITO y se exige que la suite correspondiente FALLE.
// Si al romperla sigue en verde, el test es decorativo y hay que arreglarlo.
//
//   NC1  se quita el gate de `finance` de la UI de pagos
//        -> el test de UI del actor de compras DEBE fallar
//   NC2  se deja que un actor sin finance mande paid_amount > 0
//        -> el contrato del modal de compra DEBE fallar
//   NC3  se afloja la autoridad a `finance OR inventory_view_costs`
//        -> un actor inventory=false + costos=true DEBE pasar a ver la deuda
//
// El archivo fuente y la funcion de base se restauran SIEMPRE, incluso si el
// proceso se interrumpe: la restauracion va en `finally`.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
const dbContainer = process.env.SEC08C_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) throw new Error('Se requiere el contenedor de base local')

const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
const sql = q => docker(['exec', '-i', dbContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], q).trim()

const SUPPLIERS = 'src/pages/Suppliers.tsx'
const UI_TEST = 'tests/components/sec08cPaymentUiAuthority.test.tsx'

/** Corre la suite de UI. Devuelve true si PASA. */
const uiSuitePasses = () => {
  try {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--config', 'vitest.config.ts', UI_TEST],
      { encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 })
    return true
  } catch { return false }
}

let checks = 0
const expect = (c, l) => { checks++; assert(c, l) }

// ── NC1 / NC2 — mutaciones de la UI ─────────────────────────────────────────
const original = readFileSync(SUPPLIERS, 'utf8')
const mutateSource = (label, mutate) => {
  const mutated = mutate(original)
  expect(mutated !== original, `${label}: la mutacion no cambio el archivo — el ancla ya no existe`)
  writeFileSync(SUPPLIERS, mutated)
  const passed = uiSuitePasses()
  writeFileSync(SUPPLIERS, original)
  expect(!passed, `CONTROL NEGATIVO INUTIL — «${label}»: al romper la frontera la suite SIGUIO en verde`)
  console.log(`  ✓ ${label} — la suite cae al romperla`)
}

// ── NC3 — mutacion de la autoridad en la base ───────────────────────────────
const AUTHORITY_TIGHT = `
CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_business_id IS NOT NULL
     AND ( public.current_user_can_in_business(p_business_id, 'finance')
        OR ( public.current_user_can_in_business(p_business_id, 'inventory')
         AND public.current_user_can_in_business(p_business_id, 'inventory_view_costs') ) );
$$;`
const AUTHORITY_LOOSE = `
CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_business_id IS NOT NULL
     AND ( public.current_user_can_in_business(p_business_id, 'finance')
        OR public.current_user_can_in_business(p_business_id, 'inventory_view_costs') );
$$;`

const main = async () => {
  console.log('--- NC1 / NC2 · UI ---')
  mutateSource('NC1 — quitar el gate de finance de la UI de pagos',
    src => src
      .replace('{canFinance && (\n              <button data-testid="supplier-pay-header"',
        '{true && (\n              <button data-testid="supplier-pay-header"')
      .replace('{showModalPayment && canFinance && (', '{showModalPayment && (')
      .replace('{canFinance ? (\n              <button data-testid="supplier-pay-tab"',
        '{true ? (\n              <button data-testid="supplier-pay-tab"'))

  mutateSource('NC2 — permitir pago inicial sin finance',
    src => src
      .replace('const effectivePaid = canFinance ? paidAmount : 0', 'const effectivePaid = paidAmount')
      .replace('{canFinance ? (\n              <>\n              {/* 3 estados de pago */}',
        '{true ? (\n              <>\n              {/* 3 estados de pago */}'))

  // ── NC3 ───────────────────────────────────────────────────────────────────
  console.log('\n--- NC3 · autoridad de lectura ---')
  const rest = JSON.parse(docker(['inspect', `supabase_rest_${project}`]))[0]
  const kong = JSON.parse(docker(['inspect', `supabase_kong_${project}`]))[0]
  const vars = Object.fromEntries(rest.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] }))
  const apiUrl = `http://127.0.0.1:${kong.NetworkSettings.Ports['8000/tcp'][0].HostPort}/rest/v1`
  let key = Buffer.from(vars.PGRST_JWT_SECRET)
  if (vars.PGRST_JWT_SECRET.trim().startsWith('{')) {
    key = Buffer.from(JSON.parse(vars.PGRST_JWT_SECRET).keys.find(x => x.kty === 'oct').k, 'base64url')
  }
  const ids = Object.fromEntries(['biz', 'owner', 'costOnly', 'sup', 'pur'].map(n => [n, randomUUID()]))
  const DEBT = 51988
  const TAG = 'sec08c-nc3.invalid'
  const token = id => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const c = Buffer.from(JSON.stringify({ role: 'authenticated', aud: 'authenticated', sub: id, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
    return `${h}.${c}.${createHmac('sha256', key).update(`${h}.${c}`).digest('base64url')}`
  }
  const probe = async () => {
    const r = await fetch(`${apiUrl}/v_finance_supplier_debt?business_id=eq.${ids.biz}&select=outstanding_ars`, {
      headers: { Authorization: `Bearer ${token(ids.costOnly)}` }, signal: AbortSignal.timeout(15000),
    })
    return await r.text()
  }

  let seeded = false
  try {
    sql(`
      BEGIN;
      SET session_replication_role=replica;
      INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
        ('${ids.owner}','o@${TAG}',now()), ('${ids.costOnly}','c@${TAG}',now());
      INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status)
        VALUES ('${ids.biz}','B-NC3','${ids.owner}','pro','active');
      -- El actor del control: inventory=false, inventory_view_costs=true,
      -- finance=false. Es una combinacion que SOLO se puede fabricar con un
      -- override, y es justamente la que la fase C cierra.
      INSERT INTO public.profiles(id,business_id,role,is_active,email,permissions) VALUES
        ('${ids.owner}','${ids.biz}','owner',true,'o@${TAG}',NULL),
        ('${ids.costOnly}','${ids.biz}','sales',true,'c@${TAG}',
         '{"inventory": false, "inventory_view_costs": true, "finance": false}'::jsonb);
      INSERT INTO public.suppliers(id,business_id,name,active) VALUES ('${ids.sup}','${ids.biz}','P',true);
      INSERT INTO public.supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount,pending_amount,payment_status)
        VALUES ('${ids.pur}','${ids.biz}','${ids.sup}',current_date,73191,21203,${DEBT},'partial');
      COMMIT;
    `)
    seeded = true

    // Con la autoridad ESTRECHA (la de la fase C) el actor solo-costos NO ve.
    sql(AUTHORITY_TIGHT)
    const tight = await probe()
    expect(!tight.includes(String(DEBT)),
      `NC3: con la autoridad estrecha el actor solo-costos NO debe ver la deuda — ${tight.slice(0, 200)}`)

    // Al aflojarla a `finance OR inventory_view_costs`, la ve. Esa diferencia
    // es exactamente lo que la fase C cerro; si NO apareciera, el cambio de
    // autoridad no estaria haciendo nada.
    sql(AUTHORITY_LOOSE)
    const loose = await probe()
    expect(loose.includes(String(DEBT)),
      `CONTROL NEGATIVO INUTIL — NC3: al aflojar la autoridad el actor solo-costos SIGUE sin ver la deuda (${loose.slice(0, 200)}). El endurecimiento no cambia nada.`)
    console.log('  ✓ NC3 — solo-costos ve la deuda al aflojar, no la ve al endurecer')
  } finally {
    sql(AUTHORITY_TIGHT)
    if (seeded) {
      try {
        sql(`
          BEGIN;
          SET session_replication_role=replica;
          DELETE FROM public.supplier_purchases WHERE business_id='${ids.biz}';
          DELETE FROM public.suppliers WHERE business_id='${ids.biz}';
          DELETE FROM public.profiles WHERE business_id='${ids.biz}';
          DELETE FROM public.businesses WHERE id='${ids.biz}';
          DELETE FROM auth.users WHERE email LIKE '%@${TAG}';
          COMMIT;
        `)
      } catch (e) { console.error('cleanup:', e.message) }
    }
  }

  console.log(`\nSEC-08C fase C · controles negativos OK — ${checks} aserciones`)
}

main().catch(e => {
  // Restauracion defensiva: si algo exploto entre la mutacion y el restore.
  try { writeFileSync(SUPPLIERS, original) } catch { /* ya restaurado */ }
  try { sql(AUTHORITY_TIGHT) } catch { /* ya restaurada */ }
  console.error('\nSEC-08C fase C controles negativos FALLO:', e.message)
  process.exit(1)
})
