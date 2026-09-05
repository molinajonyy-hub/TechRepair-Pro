#!/usr/bin/env node
// SEC-08C — guard de la VISIBILIDAD FINANCIERA DE PROVEEDORES.
//
// Vigila las clases de regresión que cerró el lote, en la migración, en las
// migraciones POSTERIORES (una que reabra la frontera es indistinguible de una
// que la cierre si nadie la mira), y en el frontend.
//
// Clases cubiertas:
//   1. Que una policy de lectura de proveedor vuelva al gate de módulo
//      (`current_user_can('inventory')`), que era exactamente el defecto D/E.
//   2. Que la autoridad pierda el predicado de TENANT.
//   3. Que `supplier_purchase_items` pase a la autoridad de SEC-08C y con eso
//      se le entregue el costo crudo por línea al actor de finanzas.
//   4. Que la ESCRITURA de compra deje de gobernarse por `inventory` y se
//      rompa el contrato ratificado de comprar sin poder leer el costo.
//   5. Que una vista de proveedor/finanzas pierda `security_invoker=true` y
//      pase a correr con los privilegios del owner.
//   6. Que vuelvan los GRANT a `anon` sobre tablas de proveedor.
//   7. Frontend: `select('*')` (o `.select()` a secas, o un `*` ANIDADO) sobre
//      una tabla que mezcla operativo con verdad financiera.
//   8. Frontend: que vuelva el cálculo canónico de la deuda en el browser.
//   9. Frontend: que un importe financiero restringido vuelva a colapsar a 0.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20260918120000_sec08c_supplier_finance_visibility.sql'
const MIGRATION_B = 'supabase/migrations/20260919120000_sec08c_b_payment_authority_and_finance_projection.sql'
const AUTHORITY = 'can_view_supplier_finance'

/** Tablas cuya fila mezcla operativo y verdad financiera: nada de `*`. */
const MIXED_TABLES = ['supplier_purchases', 'supplier_purchase_items',
  'supplier_payments', 'supplier_account_movements']

/** Vistas que tienen que seguir siendo security_invoker. */
const INVOKER_VIEWS = ['v_finance_supplier_debt', 'v_finance_supplier_stats', 'v_finance_position']

const stripSqlComments = s => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const stripTsComments = s =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))

// ─── Frontend: localizar el .select() de CADA cadena ─────────────────────────
function selectAfter(src, fromIdx) {
  let tail = src.slice(fromIdx + 1, fromIdx + 1200)
  const stop = Math.min(
    ...[tail.indexOf(';'), tail.search(/\.from\(/)].filter(i => i >= 0).concat([tail.length]))
  tail = tail.slice(0, stop)
  const m = tail.match(/\.select\(\s*(?:(['"`])([\s\S]*?)\1)?\s*[),]/)
  if (!m) return null
  return m[1] === undefined ? { bare: true, literal: '' } : { bare: false, literal: m[2] }
}

export function scanSourceFile(path, rawSrc) {
  const src = stripTsComments(rawSrc)
  const found = []

  for (const table of MIXED_TABLES) {
    const re = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      const sel = selectAfter(src, m.index)
      if (!sel) continue
      if (sel.bare) {
        found.push(`${path}: .select() sin argumento sobre ${table} — es RETURNING * sobre una tabla con verdad financiera; usar una proyección explícita`)
        continue
      }
      // `*` suelto, incluido el de una plantilla con relaciones anidadas.
      if (/(^|[\s(,])\*\s*(,|$)/.test(sel.literal)) {
        found.push(`${path}: select('*') sobre ${table} — expone en silencio cualquier columna futura; usar una proyección explícita`)
      }
    }
    // El `*` ANIDADO: `items:supplier_purchase_items(*)` colgado de otro from()
    // no pasa por `.from('<tabla>')` y se escapaba de la regla de arriba.
    const nested = new RegExp(`(?:\\w+\\s*:\\s*)?${table}\\s*\\(\\s*\\*\\s*\\)`, 'g')
    while ((m = nested.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 60), m.index)
      if (/\.from\(\s*['"`]$/.test(before)) continue
      found.push(`${path}: relación anidada ${m[0]} — un '*' anidado arrastra las columnas financieras; nombrar las columnas`)
    }
  }

  // ── Cálculo canónico de dinero en el browser ──
  // La deuda de proveedores se agrega server-side (v_finance_supplier_debt).
  // Un reduce() sobre pending_amount es la reconstrucción que este lote quitó.
  //
  // La ventana se corta en el arranque de la SIGUIENTE sentencia. Sin ese
  // corte, un reduce() inocente se comía la declaración de abajo y acusaba a
  // la línea equivocada: el guard reportaba «reduce sobre pending_amount» por
  // un `const` posterior que sólo lo mencionaba.
  let m
  const reduceRe = /\.reduce\(/g
  while ((m = reduceRe.exec(src)) !== null) {
    let win = src.slice(m.index, m.index + 300)
    const end = win.search(/;|\n\s*(?:const|let|var|return|function|export)\s/)
    if (end > 0) win = win.slice(0, end)
    const hit = win.match(/\b(pending_amount|outstanding_ars)\b/)
    if (hit) {
      found.push(`${path}: reduce() sobre '${hit[1]}' — la deuda con proveedores la agrega la base (v_finance_supplier_debt), no el navegador`)
    }
  }

  // ── Cero falso ──
  // Un importe financiero de proveedor que no se pudo leer NO puede caer a 0.
  const zeroRe = /\b(pending_amount|total_purchases|total_paid|outstanding_ars|supplierDebt|purchases_count)\b\s*(\|\||\?\?)\s*0\b/g
  while ((m = zeroRe.exec(src)) !== null) {
    found.push(`${path}: '${m[1]} ${m[2]} 0' — restringido se convertiría en «sin deuda»; usar null y mostrarlo como restringido`)
  }
  const stateRe = /useState\s*(?:<[^>]*>)?\s*\(\s*0\s*\)/g
  while ((m = stateRe.exec(src)) !== null) {
    const around = src.slice(Math.max(0, m.index - 120), m.index)
    if (/supplierDebt|supplier_debt|deudaProveedor/i.test(around)) {
      found.push(`${path}: la deuda de proveedores arranca en useState(0) — afirma «no hay deuda» antes de leer nada`)
    }
  }
  return found
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc) }
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p)
  }
  return acc
}

// ─── SQL ─────────────────────────────────────────────────────────────────────
/**
 * `requirePolicies` distingue dos trabajos que NO son el mismo:
 *   · sobre la migración del lote, exigir que las policies existan y tengan la
 *     forma correcta;
 *   · sobre las migraciones POSTERIORES, sólo detectar que ninguna REABRA la
 *     frontera. Una migración posterior no tiene por qué redefinirlas, y
 *     exigírselo convertía al guard en ruido.
 */
export function scanMigration(path, rawSql, { requirePolicies = true } = {}) {
  const sqlText = stripSqlComments(rawSql)
  const found = []

  const policyBody = name => sqlText.match(new RegExp(`CREATE POLICY ${name}\\b[\\s\\S]*?;`))?.[0] ?? ''

  // FASE B: `supplier_purchases_inventory_select` sale de esta lista. Su fila
  // mezcla importes con datos operativos, asi que la tabla base volvio a la
  // autoridad de COSTO y el actor de finanzas recibe una proyeccion. Eso se
  // vigila en scanPhaseB().
  for (const p of ['supplier_payments_select', 'supplier_account_movements_select']) {
    const body = policyBody(p)
    if (!body) { if (requirePolicies) found.push(`${path}: falta la policy ${p}`); continue }
    if (!body.includes(AUTHORITY)) {
      found.push(`${path}: la policy ${p} no exige ${AUTHORITY} — vuelve el defecto D/E`)
    }
    if (!body.includes('current_user_business_id')) {
      found.push(`${path}: la policy ${p} perdió el predicado de tenant`)
    }
    if (/current_user_can\(\s*'inventory'\s*\)/.test(body)) {
      found.push(`${path}: la policy ${p} volvió al gate de módulo 'inventory'`)
    }
  }

  // La línea de compra NO puede quedar gobernada por la autoridad de SEC-08C.
  const itemsPolicy = policyBody('supplier_purchase_items_inventory_select')
  if (itemsPolicy && itemsPolicy.includes(AUTHORITY)) {
    found.push(`${path}: supplier_purchase_items pasó a ${AUTHORITY} — le daría el costo crudo por línea al actor de finanzas (rompe SEC-08B)`)
  }

  // Escritura: el contrato de comprar sin poder leer el costo.
  const insertPolicy = sqlText.match(/CREATE POLICY supplier_purchases_inventory_insert\b[\s\S]*?;/)?.[0]
  if (insertPolicy && !/current_user_can\(\s*'inventory'\s*\)/.test(insertPolicy)) {
    found.push(`${path}: el INSERT de supplier_purchases dejó de gobernarse por 'inventory' — rompe el contrato de SEC-08B`)
  }

  // Las vistas declaran security_invoker explícitamente.
  for (const v of INVOKER_VIEWS) {
    const re = new RegExp(`CREATE OR REPLACE VIEW public\\.${v}\\b([\\s\\S]{0,200}?)AS`)
    const head = sqlText.match(re)?.[1]
    if (head !== undefined && !/security_invoker\s*=\s*true/i.test(head)) {
      found.push(`${path}: ${v} se re-crea sin WITH (security_invoker = true) — CREATE OR REPLACE resetea reloptions y la vista correría como su owner`)
    }
  }

  // Un GRANT a anon sobre tablas de proveedor.
  const grantRe = /GRANT\s+[\s\S]{0,80}?\s+ON\s+(?:TABLE\s+)?public\.(suppliers|supplier_purchases|supplier_purchase_items|supplier_payments|supplier_account_movements)\b[\s\S]{0,80}?TO\s+([^;]+);/g
  let m
  while ((m = grantRe.exec(sqlText)) !== null) {
    if (/\banon\b/.test(m[2])) {
      found.push(`${path}: GRANT a anon sobre public.${m[1]} — anon no tiene ninguna policy sobre proveedores`)
    }
  }
  return found
}

/**
 * FASE B — las tres correcciones de la revisión independiente.
 *
 *   B1 pagar exige `finance`; comprar CON pago inicial exige además `finance`.
 *   B2 los payables restringidos no pueden volver a fabricar un 0.
 *   B3 la tabla base no entrega la fila cruda al actor de finanzas, y la
 *      proyección financiera no publica campos operativos.
 */
export function scanPhaseB(path, rawSql) {
  const sqlText = stripSqlComments(rawSql)
  const found = []

  // B3 · la tabla base vuelve a la autoridad de costo.
  const basePolicy = sqlText.match(/CREATE POLICY supplier_purchases_inventory_select\b[\s\S]*?;/)?.[0] ?? ''
  if (!basePolicy) {
    found.push(`${path}: falta la policy supplier_purchases_inventory_select`)
  } else {
    if (basePolicy.includes(AUTHORITY)) {
      found.push(`${path}: supplier_purchases volvió a ${AUTHORITY} — un actor finance-only se llevaría la fila cruda (invoice_number, notes, attachment_url, created_by)`)
    }
    if (!basePolicy.includes('can_view_inventory_cost')) {
      found.push(`${path}: supplier_purchases perdió el gate de costo de SEC-08B`)
    }
    if (!basePolicy.includes('current_user_business_id')) {
      found.push(`${path}: supplier_purchases perdió el predicado de tenant`)
    }
  }

  // B3 · la proyección no publica campos operativos.
  const proj = sqlText.match(/CREATE OR REPLACE FUNCTION public\.finance_supplier_purchases\(\)[\s\S]*?\$function\$;/)?.[0]
  if (!proj) {
    found.push(`${path}: falta la proyección finance_supplier_purchases()`)
  } else {
    for (const col of ['invoice_number', 'payment_method', 'notes', 'attachment_url', 'created_by']) {
      if (new RegExp(`\\b${col}\\b`).test(proj)) {
        found.push(`${path}: la proyección financiera expone el campo operativo '${col}'`)
      }
    }
    if (!proj.includes('current_user_business_id')) found.push(`${path}: la proyección no liga el tenant`)
    if (!proj.includes(AUTHORITY)) found.push(`${path}: la proyección no exige ${AUTHORITY}`)
    if (!/SET\s+search_path/i.test(proj)) found.push(`${path}: la proyección SECDEF no fija search_path`)
  }
  if (proj && !/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.finance_supplier_purchases\(\)\s+FROM\s+PUBLIC/i.test(sqlText)) {
    found.push(`${path}: la proyección SECDEF nace abierta (falta REVOKE ... FROM PUBLIC)`)
  }

  // B1 · autoridad de escritura de pagos.
  for (const fn of ['pay_supplier_free_atomic', 'pay_supplier_purchase_atomic']) {
    const body = sqlText.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b[\\s\\S]*?\\$function\\$;`))?.[0]
    if (!body) { found.push(`${path}: falta el wrapper de ${fn}`); continue }
    if (/require_action_authority\(\s*p_business_id\s*,\s*'inventory'/.test(body)) {
      found.push(`${path}: ${fn} volvió a exigir 'inventory' — mover dinero no es una operación de inventario`)
    }
    if (!/require_action_authority\(\s*p_business_id\s*,\s*'finance'/.test(body)) {
      found.push(`${path}: ${fn} no exige 'finance'`)
    }
  }
  // B1 · comprar CON pago inicial exige ademas finance.
  for (const [fn, param] of [['create_supplier_purchase_atomic', 'p_paid_amount'],
    ['create_quick_inventory_purchase_atomic', 'p_paid_ars']]) {
    const body = sqlText.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b[\\s\\S]*?\\$function\\$;`))?.[0]
    if (!body) { found.push(`${path}: falta el wrapper de ${fn}`); continue }
    if (!body.includes(`'inventory'`)) found.push(`${path}: ${fn} dejó de exigir 'inventory'`)
    if (!(body.includes(`'finance'`) && new RegExp(`${param}[\\s\\S]{0,40}> 0`).test(body))) {
      found.push(`${path}: ${fn} no exige 'finance' cuando ${param} > 0 — el pago inicial movería caja sin autoridad financiera`)
    }
  }

  // B2 · la RPC de charts tiene que transportar la autorización.
  const l1 = sqlText.match(/CREATE OR REPLACE FUNCTION public\.get_finance_charts_l1\b[\s\S]*?\$function\$;/)?.[0]
  if (l1) {
    if (!l1.includes(`'is_authorized', v_pay_auth`)) {
      found.push(`${path}: get_finance_charts_l1 no transporta is_authorized en payables`)
    }
    if (/'total',\s*\(SELECT round\(COALESCE\(sum\(amount\), 0\), 2\) FROM pay\)/.test(l1)) {
      found.push(`${path}: get_finance_charts_l1 volvió al COALESCE que fabrica un 0 en payables_aging`)
    }
  }
  return found
}

export function scanAuthority(rawSql) {
  const sqlText = stripSqlComments(rawSql)
  const found = []
  const fn = sqlText.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${AUTHORITY}[\\s\\S]*?\\$\\$;`))?.[0]
  if (!fn) return [`${MIGRATION}: no se encontró la definición de ${AUTHORITY}`]
  if (/SECURITY\s+DEFINER/i.test(fn)) {
    found.push(`${MIGRATION}: ${AUTHORITY} pasó a SECURITY DEFINER — no necesita elevación y sería superficie de bypass`)
  }
  if (!/SET\s+search_path/i.test(fn)) {
    found.push(`${MIGRATION}: ${AUTHORITY} no fija search_path`)
  } else if (!/search_path\s+TO\s+[^\n]*pg_temp'\s*$/im.test(fn.split('\n').find(l => /search_path/i.test(l)) + '\n')) {
    // pg_temp tiene que ir AL FINAL: omitirlo lo pone primero y habilita shadowing.
    const line = fn.split('\n').find(l => /search_path/i.test(l)) || ''
    if (!/pg_temp'\s*$/.test(line.trim())) {
      found.push(`${MIGRATION}: el search_path de ${AUTHORITY} no termina en pg_temp — quedaría primero y permitiría shadowing`)
    }
  }
  // Compone capabilities EXISTENTES.
  for (const cap of ['finance', 'inventory_view_costs']) {
    if (!fn.includes(`'${cap}'`)) {
      found.push(`${MIGRATION}: ${AUTHORITY} ya no compone la capability '${cap}'`)
    }
  }
  if (/'supplier_finance'/.test(sqlText)) {
    found.push(`${MIGRATION}: aparece una capability 'supplier_finance' — el lote usa capabilities existentes, no inventa una nueva`)
  }
  // Ligada al negocio, no ciega al tenant.
  if (/current_user_can\s*\(/.test(fn) && !/current_user_can_in_business/.test(fn)) {
    found.push(`${MIGRATION}: ${AUTHORITY} resuelve la capacidad CIEGA al tenant`)
  }
  return found
}

// ─── Self-test ───────────────────────────────────────────────────────────────
// Cada regla se rompe a propósito sobre una muestra sintética. Si al romperla
// el guard NO se queja, esa regla no estaba protegiendo nada.
function selfTest() {
  const cases = [
    ['select(*) sobre pagos', () => scanSourceFile('x.ts', `supabase.from('supplier_payments').select('*')`)],
    ['.select() a secas', () => scanSourceFile('x.ts', `supabase.from('supplier_account_movements').select()`)],
    ['* anidado', () => scanSourceFile('x.ts', `supabase.from('supplier_purchases').select('id, items:supplier_purchase_items(*)')`)],
    ['reduce de deuda', () => scanSourceFile('x.ts', `rows.reduce((s, r) => s + r.pending_amount, 0)`)],
    ['cero falso', () => scanSourceFile('x.ts', `const d = row.pending_amount ?? 0`)],
    ['useState(0) de deuda', () => scanSourceFile('x.ts', `const [supplierDebt, setSupplierDebt] = useState(0)`)],
    ['policy con gate de modulo', () => scanMigration('m.sql',
      `CREATE POLICY supplier_payments_select ON public.supplier_payments FOR SELECT TO authenticated USING (business_id = public.current_user_business_id() AND public.current_user_can('inventory'));
       CREATE POLICY supplier_account_movements_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));
       CREATE POLICY supplier_purchases_inventory_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));`)],
    ['policy sin tenant', () => scanMigration('m.sql',
      `CREATE POLICY supplier_payments_select ON x FOR SELECT USING (can_view_supplier_finance(business_id));
       CREATE POLICY supplier_account_movements_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));
       CREATE POLICY supplier_purchases_inventory_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));`)],
    ['linea de compra relajada', () => scanMigration('m.sql',
      `CREATE POLICY supplier_payments_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));
       CREATE POLICY supplier_account_movements_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));
       CREATE POLICY supplier_purchases_inventory_select ON x FOR SELECT USING (public.current_user_business_id() AND can_view_supplier_finance(business_id));
       CREATE POLICY supplier_purchase_items_inventory_select ON x FOR SELECT USING (can_view_supplier_finance(business_id));`)],
    ['vista sin security_invoker', () => scanMigration('m.sql',
      `CREATE OR REPLACE VIEW public.v_finance_supplier_debt AS SELECT 1;`)],
    ['grant a anon', () => scanMigration('m.sql', `GRANT SELECT ON public.supplier_payments TO anon;`)],
    ['autoridad SECDEF', () => scanAuthority(
      `CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public','pg_temp' AS $$ SELECT current_user_can_in_business(p_business_id,'finance') OR current_user_can_in_business(p_business_id,'inventory_view_costs'); $$;`)],
    ['autoridad ciega al tenant', () => scanAuthority(
      `CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public','pg_temp' AS $$ SELECT current_user_can('finance') OR current_user_can('inventory_view_costs'); $$;`)],
    // ── Fase B ──
    ['B1 pago vuelve a inventory', () => scanPhaseB('b.sql',
      `CREATE OR REPLACE FUNCTION public.pay_supplier_free_atomic(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN PERFORM private.require_action_authority(p_business_id, 'inventory', NULL, NULL); END; $function$;`)],
    ['B1 comprar con pago sin finance', () => scanPhaseB('b.sql',
      `CREATE OR REPLACE FUNCTION public.create_supplier_purchase_atomic(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN PERFORM private.require_action_authority(p_business_id, 'inventory', NULL, NULL); END; $function$;`)],
    ['B3 base vuelve a la autoridad financiera', () => scanPhaseB('b.sql',
      `CREATE POLICY supplier_purchases_inventory_select ON public.supplier_purchases FOR SELECT TO authenticated USING (business_id = public.current_user_business_id() AND public.can_view_supplier_finance(business_id));`)],
    ['B3 proyeccion filtra campo operativo', () => scanPhaseB('b.sql',
      `CREATE OR REPLACE FUNCTION public.finance_supplier_purchases() RETURNS TABLE (id uuid, notes text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public','pg_temp' AS $function$ SELECT sp.id, sp.notes FROM public.supplier_purchases sp WHERE sp.business_id = public.current_user_business_id() AND public.can_view_supplier_finance(sp.business_id); $function$;`)],
    ['B2 vuelve el cero fabricado', () => scanPhaseB('b.sql',
      `CREATE OR REPLACE FUNCTION public.get_finance_charts_l1(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $function$ BEGIN RETURN jsonb_build_object('payables_aging', jsonb_build_object('total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM pay))); END; $function$;`)],
    ['capability inventada', () => scanAuthority(
      `CREATE OR REPLACE FUNCTION public.can_view_supplier_finance(p_business_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public','pg_temp' AS $$ SELECT current_user_can_in_business(p_business_id,'supplier_finance') OR current_user_can_in_business(p_business_id,'finance') OR current_user_can_in_business(p_business_id,'inventory_view_costs'); $$;`)],
  ]
  let bad = 0
  for (const [name, fn] of cases) {
    const out = fn()
    if (out.length === 0) { console.error(`  x REGLA INÚTIL — «${name}» no disparó ningún hallazgo`); bad++ }
    else console.log(`  ✓ ${name} — detectado (${out.length})`)
  }
  if (bad) { console.error(`\nSEC-08C guard self-test FALLÓ: ${bad} reglas no prueban nada`); process.exit(1) }
  console.log(`\nSEC-08C guard self-test OK — ${cases.length} reglas disparan al romperlas`)
}

// ─── Main ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const problems = []
const migrationSql = readFileSync(MIGRATION, 'utf8')
problems.push(...scanMigration(MIGRATION, migrationSql))
problems.push(...scanAuthority(migrationSql))
problems.push(...scanPhaseB(MIGRATION_B, readFileSync(MIGRATION_B, 'utf8')))

// Migraciones POSTERIORES: una que reabra la frontera importa tanto como ésta.
for (const f of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql'))) {
  if (f >= '20260918120000' && !f.startsWith('20260918120000')) {
    problems.push(...scanMigration(`supabase/migrations/${f}`,
      readFileSync(join('supabase/migrations', f), 'utf8'), { requirePolicies: false }))
  }
}

for (const f of walk('src')) {
  problems.push(...scanSourceFile(f, readFileSync(f, 'utf8')))
}

if (problems.length) {
  console.error('SEC-08C guard FALLÓ:\n' + problems.map(p => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log('SEC-08C guard OK — frontera de proveedores intacta en migración y frontend')
