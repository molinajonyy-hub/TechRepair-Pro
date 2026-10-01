#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-2S · Guard estatico de la autoridad server-side de Mayorista y de
// la autoridad interna de Portal Clic.
//
// La matriz real vive en tests/sql/prebeta3a2s_*.test.sql (base local). Este
// guard fija el CONTRATO en el codigo que la matriz no ve: las migraciones del
// lote, cualquier migracion POSTERIOR que lo reabra, y el frontend que tiene
// que consumir la misma autoridad.
//
//   node scripts/guards/prebeta3a2s-server-authority.mjs [--self-test]
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = 'supabase/migrations'
const MIG_WHOLESALE = '20261011120000_prebeta3a2s_wholesale_server_authority.sql'
const MIG_CLIC = '20261011130000_prebeta3a2s_portal_clic_internal_authority.sql'
const read = (p) => readFileSync(p, 'utf8')
const sinComentarios = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
const codigo = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

function inspectWholesale(mig) {
  const f = []
  const sql = sinComentarios(mig)
  const need = (re, label) => { if (!re.test(sql)) f.push(label) }
  need(/WHEN 'mayorista'\s+THEN p_plan IN \('pro','full'\) OR p_status = 'trialing'/, 'plan: mayorista dejo de ser Pro+ (trial incluido)')
  need(/SELECT private\.business_feature_enabled\(public\.current_user_business_id\(\), p_feature\)/, 'business_has_feature no delega en la regla unica de plan')
  if ((sql.match(/'mayorista',\s+"public"\."_feat_pro"\(/g) || []).length !== 2) f.push('RPC de features / portal: mayorista no resuelve con _feat_pro')
  need(/WHEN 'wholesale' THEN p_role IN \('admin'\)\n/, "default de 'wholesale' distinto de solo admin (manager/sales no lo traen)")
  need(/IF v_role NOT IN \('owner', 'admin'\)\s+AND NOT private\.capability_resolve\(v_role, v_perms, 'wholesale'\) THEN\s+RETURN 'none';/, 'owner/admin dejaron de ser automaticos (dependen de la capacidad)')
  need(/IF v_role IN \('owner', 'admin', 'manager', 'sales'\) THEN RETURN 'manage'; END IF;/, 'escritura mayorista no es owner/admin/manager/sales')
  need(/IF NOT private\.business_feature_enabled\(p_business_id, 'mayorista'\) THEN RETURN 'none'; END IF;/, 'el acceso Mayorista no exige la feature del negocio')
  for (const p of ['wc_staff_read', 'wo_staff_read', 'woi_staff_read']) {
    if (!new RegExp(`CREATE POLICY ${p} ON [^;]*public\\.current_user_has_wholesale_access\\(business_id\\)\\);`).test(sql)) f.push(`${p} no usa la autoridad de acceso`)
  }
  if ((sql.match(/IF NOT public\.current_user_can_manage_wholesale\(p_business_id\) THEN/g) || []).length < 3) f.push('las RPC de escritura/conversion no exigen gestion Mayorista')
  if (/current_user_can_in_business\([^)]*'wholesale'\)/.test(sql)) f.push("vuelve a usar current_user_can_in_business(..., 'wholesale')")
  need(/CREATE TRIGGER trig_customers_wholesale_authority\s+BEFORE INSERT OR UPDATE OF customer_type, business_name, contact_person, business_id\s+ON public\.customers/, 'falta el trigger de autoridad de customers')
  need(/IF NEW\.customer_type = 'mayorista'\s+AND NOT public\.current_user_has_wholesale_access\(NEW\.business_id\) THEN/, 'el trigger deja crear mayoristas sin autoridad')
  need(/NEW\.business_name\s+IS NOT DISTINCT FROM OLD\.business_name\s+AND NEW\.contact_person IS NOT DISTINCT FROM OLD\.contact_person/, 'el trigger no protege business_name/contact_person de un mayorista')
  // Dentro del CUERPO del checkout (la postcondicion repite la linea como literal).
  const checkout = sql.match(/CREATE OR REPLACE FUNCTION private\.create_comprobante_checkout_atomic\([\s\S]*?\$function\$;/)
  if (!checkout || !/v_is_wholesale := v_is_wholesale AND public\.current_user_has_wholesale_access\(p_business_id\);/.test(checkout[0])) {
    f.push('el checkout aplica precio mayorista sin autoridad del actor')
  }
  need(/CREATE FUNCTION public\.get_or_create_customer_from_wholesale_atomic\(/, 'falta la RPC de conversion portal -> customers')
  if (/ilike/i.test(sql)) f.push('la conversion volvio a matching ambiguo (ilike)')
  need(/CUSTOMER_MATCH_AMBIGUOUS/, 'la conversion elige silenciosamente entre homonimos')
  if (/GRANT[^;]*ON FUNCTION public\.(current_user_has_wholesale_access|current_user_can_manage_wholesale|get_or_create_customer_from_wholesale_atomic)[^;]*\b(anon|PUBLIC)\b/i.test(sql)) f.push('helper Mayorista ejecutable por anon/PUBLIC')
  if (/(UPDATE|DELETE FROM|INSERT INTO)\s+public\.customers\b(?![\s\S]{0,40}\(business_id, name, email, phone, customer_type, business_name, created_by\))/i.test(sql)) {
    f.push('la migracion escribe customers (solo la RPC de conversion puede insertar)')
  }
  return f
}

function inspectClic(mig) {
  const f = []
  const sql = sinComentarios(mig)
  if (!/tool_key\s+text\s+PRIMARY KEY/.test(sql)) f.push('tool_key dejo de garantizar UN principal por herramienta')
  if (/user_id[^,\n]*UNIQUE|UNIQUE\s*\(\s*user_id\s*\)/i.test(sql)) f.push('user_id UNIQUE global (impide otra herramienta a la misma identidad)')
  if (/INSERT INTO private\.internal_tool_principals\s*\(/i.test(sql)) f.push('la migracion bindea un principal (el binding es un paso manual)')
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sql) || /@[a-z0-9-]+\.[a-z]{2,}/i.test(sql)) f.push('identidad hardcodeada en la migracion')
  if (/GRANT[^;]*ON (TABLE )?private\.internal_tool_principal/i.test(sql)) f.push('la API recibe grants sobre el principal')
  if (!/REVOKE ALL ON TABLE private\.internal_tool_principals FROM PUBLIC, anon, authenticated, service_role;/.test(sql)) f.push('falta revocar la tabla del principal a la API')
  const pol = sql.match(/CREATE POLICY cwps_internal_tool[\s\S]*?;/)
  if (!pol || !/current_user_has_internal_tool_access\('portal_clic', business_id\)/.test(pol[0])) f.push('clic_wholesale_product_settings no usa la autoridad interna')
  if (pol && /owner_user_id|wholesale_portal_enabled|system_admins|current_user_can|business_has_feature/.test(pol[0])) f.push('Portal Clic vuelve a depender de owner/flag/system_admin/capacidad/plan')
  if ((sql.match(/CREATE POLICY portal_clic_objects_(select|insert|update|delete) ON storage\.objects[\s\S]*?current_user_has_internal_tool_access\('portal_clic'/g) || []).length !== 4) f.push('storage de Portal Clic sin la autoridad interna')
  const helper = sql.match(/CREATE FUNCTION public\.current_user_has_internal_tool_access[\s\S]*?\$\$;/)
  if (!helper || !/t\.user_id\s+=\s+auth\.uid\(\)/.test(helper[0]) || !/t\.business_id = p_business_id/.test(helper[0]) || !/t\.active/.test(helper[0])) {
    f.push('el helper interno no ata identidad + negocio + activo')
  }
  if (helper && /system_admins|wholesale_portal_enabled|subscription_plan/.test(helper[0])) f.push('el helper interno depende de system_admins/flag/plan')
  return f
}

/** Ninguna migracion POSTERIOR reabre el contrato. */
function inspectPosteriores(archivos) {
  const f = []
  for (const { nombre, sql: crudo } of archivos) {
    if (nombre <= MIG_CLIC) continue
    const sql = sinComentarios(crudo)
    if (/WHEN 'wholesale' THEN p_role IN \([^)]*'(manager|sales)'/.test(sql)) f.push(`${nombre}: devuelve 'wholesale' por defecto a manager/sales`)
    if (/WHEN 'mayorista'\s+THEN (b\.|p_)?(subscription_)?plan = 'full'/.test(sql) || /'mayorista',\s+"?public"?\."?_feat_full"?\(/.test(sql)) f.push(`${nombre}: Mayorista vuelve a Full-only`)
    if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+private\.create_comprobante_checkout_atomic\(/.test(sql)
        && !/v_is_wholesale := v_is_wholesale AND public\.current_user_has_wholesale_access\(p_business_id\);/.test(sql)) f.push(`${nombre}: redefine el checkout sin la autoridad Mayorista`)
    if (/CREATE POLICY[^;]*ON\s+(public\.)?wholesale_(customers|orders|order_items)[^;]*current_user_can\('wholesale'\)/.test(sql)) f.push(`${nombre}: policy mayorista con la capacidad cruda`)
    if (/DROP TRIGGER[^;]*trig_customers_wholesale_authority/i.test(sql) || /ALTER TABLE[^;]*customers[^;]*DISABLE TRIGGER/i.test(sql)) f.push(`${nombre}: apaga el trigger de customers`)
    if (/CREATE POLICY[^;]*ON\s+(public\.)?clic_wholesale_product_settings[^;]*(owner_user_id|wholesale_portal_enabled)/i.test(sql)) f.push(`${nombre}: Portal Clic vuelve a owner/flag`)
    if (/GRANT[^;]*ON (TABLE )?private\.internal_tool_principals[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(sql)) f.push(`${nombre}: la API recibe el principal interno`)
    if (/INSERT INTO private\.internal_tool_principals/i.test(sql)) f.push(`${nombre}: bindea un principal desde una migracion`)
  }
  return f
}

function inspectFrontend(src) {
  const f = []
  const app = codigo(src.app)
  if (!/<Route element=\{<ProtectedRouteByInternalTool tool="portal_clic" \/>\}>\s*<Route path="\/portal-clic"/.test(app)) f.push('/portal-clic no esta bajo la autoridad interna')
  if (/ProtectedRouteByPermission permission="wholesale"|ProtectedRouteByFeature feature="mayorista"/.test(app)) f.push('App.tsx vuelve a gatear Mayorista/Portal Clic con permiso+feature')
  if (!/if \(item\.clicPortalManage\) return access\.portalClic\n/.test(codigo(src.nav))) f.push('el menu de Portal Clic no usa la autoridad interna')
  if (!/useInternalToolAccess\('portal_clic'\)/.test(codigo(src.adminClic))) f.push('AdminPortalClic no usa la autoridad interna')
  if (/canManageClicPortal|isBusinessOwner|wholesalePortalEnabled/.test(codigo(src.adminClic) + codigo(src.nav) + codigo(src.wholesalePerms))) f.push('Portal Clic vuelve a decidirse por owner real + flag')
  if (!/\.rpc\('current_user_has_internal_tool_access'/.test(codigo(src.internalHook))) f.push('el hook interno no consulta la autoridad server-side')
  if (/system_admins|isSystemOwner|owner_user_id|wholesale_portal_enabled/.test(codigo(src.internalHook))) f.push('el hook interno depende de system_admins/owner/flag')
  const pos = codigo(src.pos)
  if (!/const \{ canAccess: puedeCotizarMayorista \} = useWholesaleAccess\(\)/.test(pos)
      || !/resolvesWholesalePricing\(\{[\s\S]{0,200}canAccessWholesale: puedeCotizarMayorista,/.test(pos)) f.push('el POS cotiza mayorista sin la autoridad central')
  if (/usarPrecioMayorista \|\| isWholesaleCustomer\(selectedCliente\)/.test(pos)) f.push('el POS vuelve a cotizar mayorista solo por customer_type')
  const portal = codigo(src.portalService)
  if (/from\(\s*'customers'\s*\)[\s\S]{0,200}\.insert\(/.test(portal)) f.push('portalService vuelve a insertar customers directo')
  if (!/\.rpc\('get_or_create_customer_from_wholesale_atomic'/.test(portal)) f.push('la conversion no usa la RPC canonica')
  return f
}

function leerMigraciones() {
  return readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort().map((nombre) => ({ nombre, sql: read(join(MIG_DIR, nombre)) }))
}

function leerFrontend() {
  return {
    app: read('src/App.tsx'),
    nav: read('src/hooks/useNavigationAccess.ts'),
    adminClic: read('src/pages/AdminPortalClic.tsx'),
    wholesalePerms: read('src/hooks/useWholesalePermissions.ts'),
    internalHook: read('src/hooks/useInternalToolAccess.ts'),
    pos: read('src/components/comprobantes/ComprobanteProModal.tsx'),
    portalService: read('src/portal/services/portalService.ts'),
  }
}

function run(s) {
  return [
    ...inspectWholesale(s.migWholesale).map((x) => `migracion Mayorista: ${x}`),
    ...inspectClic(s.migClic).map((x) => `migracion Portal Clic: ${x}`),
    ...inspectPosteriores(s.migraciones),
    ...inspectFrontend(s.src).map((x) => `frontend: ${x}`),
  ]
}

function estado() {
  const migraciones = leerMigraciones()
  const get = (n) => {
    const m = migraciones.find((x) => x.nombre === n)
    if (!m) throw new Error(`falta la migracion ${n}`)
    return m.sql
  }
  return { migraciones, migWholesale: get(MIG_WHOLESALE), migClic: get(MIG_CLIC), src: leerFrontend() }
}

function mutar(texto, de, a) {
  const next = texto.replace(de, a)
  if (next === texto) throw new Error(`self-test: la mutacion no aplico (${String(de).slice(0, 70)})`)
  return next
}

if (process.argv.includes('--self-test')) {
  const base = estado()
  const limpio = run(base)
  if (limpio.length) throw new Error(`self-test: falso positivo sobre el repo: ${limpio.join(' | ')}`)
  const conMig = (campo, de, a) => ({ ...base, [campo]: mutar(base[campo], de, a) })
  const conSrc = (campo, de, a) => ({ ...base, src: { ...base.src, [campo]: mutar(base.src[campo], de, a) } })
  const posterior = (sql) => ({ ...base, migraciones: [...base.migraciones, { nombre: '20261099120000_regresion.sql', sql }] })
  const casos = [
    ['Pro vuelve a Full-only (regla de plan)', conMig('migWholesale', "WHEN 'mayorista'       THEN p_plan IN ('pro','full') OR p_status = 'trialing'", "WHEN 'mayorista'       THEN p_plan = 'full'"), 'Pro+'],
    ['RPC de features vuelve a _feat_full', conMig('migWholesale', /'mayorista',        "public"\."_feat_pro"\(/, `'mayorista',        "public"."_feat_full"(`), '_feat_pro'],
    ['manager vuelve a wholesale por defecto', conMig('migWholesale', "WHEN 'wholesale' THEN p_role IN ('admin')\n", "WHEN 'wholesale' THEN p_role IN ('admin','manager','sales')\n"), 'solo admin'],
    ['admin override false vuelve a bloquear', conMig('migWholesale', "IF v_role NOT IN ('owner', 'admin')\n     AND NOT private.capability_resolve", "IF v_role NOT IN ('owner')\n     AND NOT private.capability_resolve"), 'automaticos'],
    ['tech con wholesale vuelve a escribir', conMig('migWholesale', "IF v_role IN ('owner', 'admin', 'manager', 'sales') THEN RETURN 'manage'; END IF;", "IF v_role IN ('owner', 'admin', 'manager', 'sales', 'tech') THEN RETURN 'manage'; END IF;"), 'owner/admin/manager/sales'],
    ['lectura mayorista por capacidad cruda', conMig('migWholesale', 'CREATE POLICY wc_staff_read ON public.wholesale_customers FOR SELECT TO authenticated\n  USING (business_id = public.current_business_id()\n    AND public.current_user_has_wholesale_access(business_id));', "CREATE POLICY wc_staff_read ON public.wholesale_customers FOR SELECT TO authenticated\n  USING (business_id = public.current_business_id()\n    AND public.current_user_can('wholesale'));"), 'wc_staff_read'],
    ['customers permite minorista -> mayorista sin autoridad', conMig('migWholesale', /CREATE TRIGGER trig_customers_wholesale_authority[\s\S]*?enforce_customer_wholesale_authority\(\);/, ''), 'trigger'],
    ['customers deja crear mayoristas', conMig('migWholesale', "IF NEW.customer_type = 'mayorista'\n       AND NOT public.current_user_has_wholesale_access(NEW.business_id) THEN", "IF false THEN"), 'crear mayoristas'],
    ['checkout vuelve a usar solo customer_type', conMig('migWholesale', 'v_is_wholesale := v_is_wholesale AND public.current_user_has_wholesale_access(p_business_id);', 'v_is_wholesale := v_is_wholesale;'), 'checkout'],
    ['conversion con ilike', conMig('migWholesale', 'AND lower(btrim(c.email)) = v_email;', 'AND c.name ILIKE v_wc.name;'), 'ilike'],
    ['Portal Clic vuelve a owner', conMig('migClic', "USING (business_id = public.current_user_business_id()\n         AND public.current_user_has_internal_tool_access('portal_clic', business_id))", "USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.owner_user_id = auth.uid()))"), 'owner/flag'],
    ['Portal Clic vuelve a system_admin', conMig('migClic', 'AND t.user_id     = auth.uid()', 'AND EXISTS (SELECT 1 FROM public.system_admins sa WHERE sa.user_id = auth.uid())'), 'identidad'],
    ['principal unico por user_id', conMig('migClic', 'user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,', 'user_id        uuid        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,'), 'UNIQUE'],
    ['migracion bindea al principal', conMig('migClic', 'COMMIT;', "INSERT INTO private.internal_tool_principals (tool_key, user_id, business_id, granted_reason) VALUES ('portal_clic', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'hardcode');\nCOMMIT;"), 'bindea'],
    ['la API lee el principal', conMig('migClic', 'COMMIT;', 'GRANT SELECT ON TABLE private.internal_tool_principals TO authenticated;\nCOMMIT;'), 'grants'],
    ['posterior: Mayorista Full-only', posterior("CREATE OR REPLACE FUNCTION x() RETURNS jsonb AS $$ SELECT jsonb_build_object('mayorista', \"public\".\"_feat_full\"(b.s, b.p)) $$;"), 'Full-only'],
    ['posterior: manager con wholesale', posterior("WHEN 'wholesale' THEN p_role IN ('admin','manager')"), 'manager/sales'],
    ['posterior: checkout sin autoridad', posterior('CREATE OR REPLACE FUNCTION private.create_comprobante_checkout_atomic(p uuid) RETURNS jsonb AS $$ SELECT 1 $$;'), 'checkout'],
    ['posterior: apaga el trigger', posterior('DROP TRIGGER trig_customers_wholesale_authority ON public.customers;'), 'trigger'],
    ['posterior: Portal Clic por owner', posterior('CREATE POLICY x ON public.clic_wholesale_product_settings USING (owner_user_id = auth.uid());'), 'owner/flag'],
    ['frontend: ruta vuelve a permiso+feature', conSrc('app', '<Route element={<ProtectedRouteByInternalTool tool="portal_clic" />}>', '<Route element={<ProtectedRouteByPermission permission="wholesale" />}>'), 'autoridad interna'],
    ['frontend: menu Portal Clic por owner', conSrc('nav', 'if (item.clicPortalManage) return access.portalClic\n', 'if (item.clicPortalManage) return access.wholesale.canAccess\n'), 'menu'],
    ['frontend: hook usa system_admins', conSrc('internalHook', ".rpc('current_user_has_internal_tool_access'", ".from('system_admins').select('user_id').rpc('current_user_has_internal_tool_access'"), 'system_admins'],
    ['frontend: POS por customer_type', conSrc('pos', /const esClienteMayorista = useMemo\(\(\) => resolvesWholesalePricing\(\{[\s\S]*?\]\)/, 'const esClienteMayorista = useMemo(() => usarPrecioMayorista || isWholesaleCustomer(selectedCliente), [usarPrecioMayorista, selectedCliente])'), 'customer_type'],
    ['frontend: POS con acceso forzado', conSrc('pos', 'canAccessWholesale: puedeCotizarMayorista,', 'canAccessWholesale: true,'), 'autoridad central'],
    ['frontend: insert directo de customers', conSrc('portalService', "const { data, error } = await supabase.rpc('get_or_create_customer_from_wholesale_atomic', {", "await supabase.from('customers').insert({ customer_type: 'mayorista' })\n  const { data, error } = await supabase.rpc('otra', {"), 'insertar customers'],
  ]
  for (const [nombre, st, esperado] of casos) {
    const hits = run(st)
    if (!hits.some((h) => h.includes(esperado))) throw new Error(`self-test no detecto: ${nombre} (hits: ${hits.join(' | ') || 'ninguno'})`)
  }
  console.log(`PRE-BETA-3A-2S guard self-test OK: ${casos.length} sabotajes detectados, 0 falsos positivos`)
  process.exit(0)
}

const fallas = run(estado())
if (fallas.length) {
  console.error('PRE-BETA-3A-2S guard FAIL:')
  for (const x of fallas) console.error(`- ${x}`)
  process.exit(1)
}
console.log('PRE-BETA-3A-2S guard OK: Mayorista Pro+ con owner/admin automaticos, wholesale_* / customers / checkout / conversion con autoridad server-side; Portal Clic con principal interno unico; frontend alineado.')
