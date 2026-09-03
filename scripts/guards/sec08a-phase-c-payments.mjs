#!/usr/bin/env node
// SEC-08A Fase C — guard de la visibilidad de pagos de comprobantes de orden.
//
// Cubre SÓLO las clases de regresión que esta fase cerró:
//
//   1. Que la lectura de `comprobante_payments` vuelva a decidir la capacidad
//      con la resolución CIEGA al tenant (`current_user_can`) en vez de con
//      `current_user_can_in_business(business_id, …)`.
//   2. Que pierda el requisito de `orders_view_financials` para los pagos de un
//      comprobante VINCULADO a una orden.
//   3. Que el helper que la policy invoca vuelva a ser INALCANZABLE para
//      `authenticated`. Éste es el defecto que traía la Fase B: su helper vivía
//      en `private` sin EXECUTE, así que la policy respondía 42501 a TODOS
//      —owner incluido— y el detalle de comprobantes estaba roto. Un error de
//      privilegio se confunde con una denegación correcta, así que el guard lo
//      vigila explícitamente.
//   4. Que se abra el esquema `private` para "arreglarlo".
//
// No hace análisis del frontend: esta fase es frontera de FILAS, no de columnas,
// así que no hay `select()` que auditar. Lo que se audita es la migración y que
// ninguna posterior la revierta.
import { readFileSync, readdirSync } from 'node:fs'

const MIGRATION = 'supabase/migrations/20260913120000_sec08a_phase_c_payment_visibility.sql'

/** Extrae el cuerpo de una policy por nombre. */
const policyBody = (sqlText, name) =>
  sqlText.match(new RegExp(`CREATE POLICY ${name}[\\s\\S]*?;`))?.[0] ?? ''

export function inspect({ migration, later }) {
  const failures = []

  // ── 1/2. La policy de pagos ──────────────────────────────────────────────
  const pay = policyBody(migration, 'cp_select_comprobantes_capability')
  if (!pay) failures.push('la migración no reescribe la policy de lectura de comprobante_payments')
  if (!/current_user_can_in_business\(\s*business_id\s*,\s*'orders_view_financials'\s*\)/.test(pay)) {
    failures.push('los pagos de un comprobante de orden no exigen orders_view_financials en el negocio de la fila')
  }
  if (!/current_user_can_in_business\(\s*business_id\s*,\s*'comprobantes'\s*\)/.test(pay)) {
    failures.push('la autoridad comercial de comprobantes dejó de resolverse en el negocio de la fila')
  }
  if (/\bpublic\.current_user_can\s*\(/.test(pay) || /[^_]\bcurrent_user_can\s*\(\s*'/.test(pay)) {
    failures.push('la lectura de pagos volvió a una decisión de capacidad CIEGA al tenant')
  }
  if (!/comprobante_is_order_linked\(\s*comprobante_id\s*\)/.test(pay)) {
    failures.push('la lectura de pagos no distingue el comprobante vinculado a una orden')
  }
  // El comprobante SUELTO no puede quedar atrapado: el mostrador se rompería.
  if (!/NOT\s+public\.comprobante_is_order_linked/.test(pay)) {
    failures.push('la policy no deja pasar el comprobante suelto: se destruiría la visibilidad de POS/mostrador')
  }

  // ── 3. El helper tiene que ser ALCANZABLE ────────────────────────────────
  const helper = migration.match(/CREATE OR REPLACE FUNCTION public\.comprobante_is_order_linked[\s\S]*?\$\$;/)?.[0] ?? ''
  if (!helper) failures.push('la migración no define el helper de relación en public')
  if (!/SECURITY DEFINER/.test(helper)) {
    failures.push('el helper de relación no es SECURITY DEFINER: dentro de una policy quedaría filtrado por la RLS de comprobantes y respondería que NO está vinculado')
  }
  if (!/GRANT EXECUTE ON FUNCTION public\.comprobante_is_order_linked\(uuid\) TO authenticated/.test(migration)) {
    failures.push('el helper no es ejecutable por authenticated: toda policy que lo invoque responderá 42501 a TODOS los roles, incluido el owner')
  }
  if (!/REVOKE EXECUTE ON FUNCTION public\.comprobante_is_order_linked\(uuid\) FROM anon/.test(migration)) {
    failures.push('el helper no le está revocado a anon')
  }
  if (!/REVOKE ALL ON FUNCTION public\.comprobante_is_order_linked\(uuid\) FROM PUBLIC/.test(migration)) {
    failures.push('el helper no le está revocado a PUBLIC')
  }

  // ── 4. El esquema cerrado sigue cerrado ──────────────────────────────────
  if (/GRANT\s+USAGE\s+ON\s+SCHEMA\s+private\s+TO\s+(authenticated|anon|PUBLIC)/i.test(migration + '\n' + later)) {
    failures.push('se concedió USAGE sobre el esquema private: ese esquema debe seguir cerrado')
  }

  // ── La policy de la Fase B quedó repuntada al helper alcanzable ──────────
  const items = policyBody(migration, 'comprobante_items_select')
  if (!items) failures.push('la migración no repunta comprobante_items_select al helper alcanzable')
  if (/private\.comprobante_is_order_linked/.test(items)) {
    failures.push('comprobante_items_select sigue apuntando al helper inalcanzable de private')
  }
  if (!/current_user_can_in_business/.test(items) || !/orders_view_financials/.test(items)) {
    failures.push('comprobante_items_select perdió el cierre del pivot de la Fase B')
  }

  // ── Postcondiciones vivas ────────────────────────────────────────────────
  for (const marker of [
    'has_function_privilege(\'authenticated\', \'public.comprobante_is_order_linked(uuid)\', \'EXECUTE\')',
    'has_schema_privilege(\'authenticated\', \'private\', \'USAGE\')',
    'policies PERMISSIVE de SELECT sobre comprobante_payments',
  ]) {
    if (!migration.includes(marker)) failures.push(`falta la postcondición: ${marker}`)
  }

  // ── Ninguna migración posterior lo revierte ──────────────────────────────
  const laterPay = policyBody(later, 'cp_select_comprobantes_capability')
  if (laterPay && !/current_user_can_in_business/.test(laterPay)) {
    failures.push('una migración posterior devuelve la lectura de pagos a una autoridad ciega al tenant')
  }
  if (laterPay && !/comprobante_is_order_linked/.test(laterPay)) {
    failures.push('una migración posterior quita la distinción de comprobante vinculado a una orden en los pagos')
  }
  if (/REVOKE\s+(?:ALL|EXECUTE)[^;]*comprobante_is_order_linked[^;]*FROM\s+authenticated/i.test(later)) {
    failures.push('una migración posterior le quita EXECUTE del helper a authenticated: las policies romperían para todos')
  }
  if (/GRANT\s+(?:SELECT|ALL)[^;(]*\bON\b[^;(]*\bcomprobante_payments\b[^;(]*\bTO\b[^;]*\banon\b/i.test(later)) {
    failures.push('una migración posterior le concede lectura de pagos a anon')
  }

  return failures
}

const load = () => {
  const all = readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
  const base = MIGRATION.split('/').at(-1)
  return {
    migration: readFileSync(MIGRATION, 'utf8'),
    later: all.filter(n => n > base).map(n => readFileSync(`supabase/migrations/${n}`, 'utf8')).join('\n'),
  }
}

if (process.argv.includes('--self-test')) {
  const src = load()
  const mutate = (field, from, to) => ({ ...src, [field]: src[field].replace(from, to) })
  // `replace` con string toca sólo la PRIMERA aparición, y la primera suele estar
  // en la policy de comprobante_items —que va antes en el archivo—, así que la de
  // pagos quedaría intacta y la mutación no probaría nada. Para las expresiones
  // que aparecen en las dos policies se muta en TODAS.
  const mutateAll = (field, from, to) => ({ ...src, [field]: src[field].split(from).join(to) })
  const mutations = [
    [mutate('migration', /AND public\.current_user_can_in_business\(business_id, 'comprobantes'\)/, "AND public.current_user_can('comprobantes')"),
      'CIEGA al tenant'],
    [mutateAll('migration', "OR public.current_user_can_in_business(business_id, 'orders_view_financials')", 'OR true'),
      'no exigen orders_view_financials'],
    [mutateAll('migration', 'NOT public.comprobante_is_order_linked(comprobante_id)', 'false'),
      'no distingue el comprobante vinculado'],
    [mutate('migration', 'GRANT EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) TO authenticated;', '-- sin grant'),
      'no es ejecutable por authenticated'],
    [mutate('migration', 'REVOKE EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) FROM anon;', '-- sin revoke'),
      'no le está revocado a anon'],
    [mutate('migration', /LANGUAGE sql STABLE SECURITY DEFINER/, 'LANGUAGE sql STABLE'),
      'no es SECURITY DEFINER'],
    [{ ...src, migration: src.migration + '\nGRANT USAGE ON SCHEMA private TO authenticated;' },
      'USAGE sobre el esquema private'],
    // Atrapar también al comprobante SUELTO: se rompería el mostrador.
    [mutateAll('migration', 'NOT public.comprobante_is_order_linked', 'public.comprobante_is_order_linked'),
      'destruiría la visibilidad de POS/mostrador'],
    [mutate('migration', "has_function_privilege('authenticated', 'public.comprobante_is_order_linked(uuid)', 'EXECUTE')", 'true'),
      'falta la postcondición'],
    [{ ...src, later: src.later + `\nCREATE POLICY cp_select_comprobantes_capability ON public.comprobante_payments FOR SELECT USING (business_id = public.current_user_business_id());` },
      'autoridad ciega al tenant'],
    [{ ...src, later: src.later + '\nREVOKE EXECUTE ON FUNCTION public.comprobante_is_order_linked(uuid) FROM authenticated;' },
      'quita EXECUTE del helper'],
    [{ ...src, later: src.later + '\nGRANT SELECT ON TABLE public.comprobante_payments TO anon;' },
      'lectura de pagos a anon'],
  ]
  for (const [mutated, label] of mutations) {
    if (!inspect(mutated).some(f => f.includes(label))) throw new Error(`self-test no detectó: ${label}`)
  }
  if (inspect(src).length) throw new Error(`self-test: falso positivo sobre la migración real: ${inspect(src).join('; ')}`)
  console.log(`SEC-08A Fase C guard self-test OK: ${mutations.length} mutaciones detectadas, migración real limpia`)
  process.exit(0)
}

const failures = inspect(load())
if (failures.length) {
  console.error(`SEC-08A Fase C payments guard FAIL:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('SEC-08A Fase C payments guard OK: la lectura de pagos exige orders_view_financials en el negocio de la fila para lo vinculado a una orden, conserva el comprobante suelto, y el helper de relación es SECURITY DEFINER y alcanzable por authenticated sin abrir el esquema private')
