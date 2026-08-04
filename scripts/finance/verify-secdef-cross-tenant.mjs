#!/usr/bin/env node
// ============================================================================
// P0 Seguridad — Verificacion cross-tenant por HTTP con JWT real.
//
// Las aserciones de catalogo (tests/sql/secdef_public_execute_lockdown.test.sql)
// prueban QUIEN tiene EXECUTE. Esto prueba lo otro: que un usuario authenticated
// legitimo del negocio A no pueda operar sobre entidades del negocio B, y que su
// propio flujo siga funcionando. Va por PostgREST, que es la superficie real.
//
//   node scripts/finance/verify-secdef-cross-tenant.mjs
//
// SOLO LOCAL: crea usuarios y negocios de prueba y despues los borra. Aborta si
// la API no es 127.0.0.1/localhost.
// ============================================================================
import { execSync } from 'node:child_process'

const st = JSON.parse(execSync('npx supabase status --output json', { encoding: 'utf8' }))
const API = st.API_URL
const ANON = st.ANON_KEY
const SERVICE = st.SERVICE_ROLE_KEY
const DB = process.env.SECDEF_DB_CONTAINER || 'supabase_db_techrepair-vite'

// ── Barrera fail-closed: nunca contra algo que no sea el stack local ────────
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API || '')) {
  console.error(`ABORTA: API_URL no es local (${API}). Este script escribe datos de prueba.`)
  process.exit(1)
}

const psql = (sql) =>
  execSync(`docker exec -i ${DB} psql -U postgres -d postgres -q -t -A -v ON_ERROR_STOP=1 -f -`,
    { encoding: 'utf8', input: sql }).trim()

const api = (path, opts) => fetch(`${API}${path}`, opts)

async function createUser(email, password) {
  const r = await api('/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const j = await r.json()
  if (!j.id) throw new Error(`createUser ${email}: ${JSON.stringify(j)}`)
  return j.id
}

async function login(email, password) {
  const r = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const j = await r.json()
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`)
  return j.access_token
}

async function rpc(token, fn, body) {
  const r = await api(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: (await r.text()).slice(0, 200) }
}

const pw = `Xtenant!${Date.now()}`
const emailA = `xt_http_a_${Date.now()}@example.invalid`
const emailB = `xt_http_b_${Date.now()}@example.invalid`
let userA, userB, bizA, bizB
let fallas = 0

try {
  userA = await createUser(emailA, pw)
  userB = await createUser(emailB, pw)

  bizA = psql(`INSERT INTO public.businesses (name, owner_user_id, subscription_status) VALUES ('XT HTTP A','${userA}','active') RETURNING id`)
  bizB = psql(`INSERT INTO public.businesses (name, owner_user_id, subscription_status) VALUES ('XT HTTP B','${userB}','active') RETURNING id`)

  psql(`INSERT INTO public.profiles (id,user_id,business_id,role,is_active,email)
        VALUES ('${userA}','${userA}','${bizA}','owner',true,'${emailA}'),
               ('${userB}','${userB}','${bizB}','owner',true,'${emailB}')
        ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id, role='owner', is_active=true`)

  const compB = psql(`INSERT INTO public.comprobantes (business_id,tipo,subtotal,impuestos,total,estado_fiscal) VALUES ('${bizB}','factura_a',1000,210,1210,'no_fiscal') RETURNING id`)
  const brandB = psql(`INSERT INTO public.brands (business_id,name,normalized_name) VALUES ('${bizB}','MarcaHttpB','marcahttpb') RETURNING id`)
  const totalBefore = psql(`SELECT total FROM public.comprobantes WHERE id='${compB}'`)

  const tokenA = await login(emailA, pw)

  const casos = [
    ['recalcular_totales_comprobante (comprobante de B)',  'recalcular_totales_comprobante', { p_comprobante_id: compB }, false],
    ['generar_numero_comprobante (negocio B)',             'generar_numero_comprobante',     { p_tipo: 'factura_a', p_business_id: bizB, p_punto_venta: '0001' }, false],
    ['generar_numero_garantia (negocio B)',                'generar_numero_garantia',        { p_business_id: bizB }, false],
    ['get_or_create_brand (negocio B)',                    'get_or_create_brand',            { p_name: 'InyectadaHttp', p_business_id: bizB }, false],
    ['get_or_create_model (marca de B con negocio A)',     'get_or_create_model',            { p_name: 'CruzadoHttp', p_brand_id: brandB, p_business_id: bizA }, false],
    ['ensure_brand_and_model (negocio B)',                 'ensure_brand_and_model',         { p_brand_name: 'M', p_model_name: 'X', p_business_id: bizB }, false],
    ['get_business_subscription_features (negocio B)',     'get_business_subscription_features', { p_business_id: bizB }, false],
    ['is_comprobante_annulled (cerrada a authenticated)',  'is_comprobante_annulled',        { p_comprobante_id: compB }, false],
    ['bootstrap_owner_profile (email ajeno)',              'bootstrap_owner_profile',        { p_user_email: emailB, p_business_name: 'Hackeado', p_full_name: null }, false],
    ['recalculate_product_prices (negocio B)',             'recalculate_product_prices',     { p_business_id: bizB, p_new_rate: 999 }, false],
    // Positivos: los flujos que usa el frontend tienen que seguir andando.
    ['generar_numero_comprobante (negocio PROPIO)',        'generar_numero_comprobante',     { p_tipo: 'factura_a', p_business_id: bizA, p_punto_venta: '0001' }, true],
    ['get_or_create_brand (negocio PROPIO)',               'get_or_create_brand',            { p_name: 'PropiaHttp', p_business_id: bizA }, true],
    ['ensure_brand_and_model (negocio PROPIO)',            'ensure_brand_and_model',         { p_brand_name: 'MarcaOk', p_model_name: 'ModeloOk', p_business_id: bizA }, true],
    ['generar_numero_garantia (negocio PROPIO)',           'generar_numero_garantia',        { p_business_id: bizA }, true],
    ['get_business_subscription_features (PROPIO)',        'get_business_subscription_features', { p_business_id: bizA }, true],
  ]

  for (const [nombre, fn, body, debePasar] of casos) {
    const { status, body: resp } = await rpc(tokenA, fn, body)
    const paso = status >= 200 && status < 300
    const ok = paso === debePasar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre.padEnd(52)} HTTP ${status} ${debePasar ? '(esperaba OK)' : '(esperaba bloqueo)'}${ok ? '' : ' <<< ' + resp}`)
  }

  // El rechazo tiene que dejar CERO cambios, no sólo devolver 403.
  const totalAfter = psql(`SELECT total FROM public.comprobantes WHERE id='${compB}'`)
  if (totalBefore !== totalAfter) { console.log(`FALLA el rechazo cambio el total de B: ${totalBefore} -> ${totalAfter}`); fallas++ }
  else console.log(`OK   cero cambios: total de B sigue en ${totalAfter}`)

  const leak = psql(`SELECT count(*) FROM public.brands WHERE business_id='${bizB}' AND normalized_name IN ('inyectadahttp','m')`)
  if (leak !== '0') { console.log(`FALLA quedaron ${leak} marca(s) inyectada(s) en B`); fallas++ }
  else console.log('OK   cero cambios: ninguna marca inyectada en B')
} finally {
  const ids = [bizA, bizB].filter(Boolean).map(x => `'${x}'`).join(',')
  const uids = [userA, userB].filter(Boolean).map(x => `'${x}'`).join(',')
  if (ids) psql(`DELETE FROM public.comprobantes WHERE business_id IN (${ids});
                 DELETE FROM public.brands WHERE business_id IN (${ids});`)
  if (uids) psql(`DELETE FROM public.profiles WHERE id IN (${uids});`)
  if (ids) psql(`DELETE FROM public.businesses WHERE id IN (${ids});`)
  if (uids) psql(`DELETE FROM auth.users WHERE id IN (${uids});`)
}

if (fallas) { console.error(`\nVerificacion cross-tenant FALLO: ${fallas} caso(s).`); process.exit(1) }
console.log('\nVerificacion cross-tenant OK: bloqueos, flujos legitimos y cero cambios tras el rechazo.')
