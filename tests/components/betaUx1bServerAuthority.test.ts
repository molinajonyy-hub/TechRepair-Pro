// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1B — Autoridad server-side de abrir (y cerrar) la caja.
//
// El POS ahora ofrece «Abrir caja» a quien tiene `finance`. Eso sólo es un
// gate de UX: el botón escondido no protege nada si el servidor acepta el
// pedido de cualquier miembro. Antes de dar el lote por cerrado hubo que
// responder UNA pregunta:
//
//   ¿la definición EFECTIVA de `open_cash_session_atomic` exige `finance`?
//
// La de julio (`20260706130000_m6_cash_sessions.sql`) no: sólo valida sesión y
// pertenencia al negocio. Pero no es la efectiva. Lote 3
// (`20260908120000_lote3_secdef_action_authority.sql`) la movió a `private` y
// publicó un wrapper que llama a `private.require_action_authority(
// p_business_id, 'finance', …)` antes de tocar nada. Por eso este lote NO trae
// migración. Estos tests dejan esa conclusión atada al repo:
//
//   A. el wrapper de Lote 3 mapea las dos RPC a `finance`;
//   B. ninguna migración posterior las redefine (si alguien lo hace, este test
//      obliga a rehacer el discovery en vez de heredar una conclusión vieja);
//   C. el snapshot versionado del catálogo de PRODUCCIÓN tiene exactamente el
//      cuerpo de ese wrapper — no la implementación de julio;
//   D. la matriz SQL existente ya prueba permitido/denegado por rol y override;
//   E. el texto con el que el cliente reconoce la carrera es el del servidor.
//
// Es estático: no necesita DB. La matriz real corre en `test:sql:lote3-authority`.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CAJA_ALREADY_OPEN_ERROR } from '../../src/services/cashSessionService'

const here = dirname(fileURLToPath(import.meta.url))
const raiz = join(here, '../../')
const leer = (rel: string) => readFileSync(join(raiz, rel), 'utf8').replace(/\r\n/g, '\n')
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

const MIGRACIONES = 'supabase/migrations'
const M6 = '20260706130000_m6_cash_sessions.sql'
const LOTE3 = '20260908120000_lote3_secdef_action_authority.sql'
const LOTE3_B = '20260909120000_lote3_phase_b_direct_write_rework.sql'

const RPCS = {
  open_cash_session_atomic:
    'p_business_id,p_user_id,p_efectivo,p_transferencia,p_tarjeta,p_usd,p_usd_rate,p_idempotency_key',
  close_cash_session_atomic:
    'p_business_id,p_user_id,p_caja_id,p_count_efectivo,p_count_transferencia,p_count_tarjeta,p_count_usd,p_usd_rate,p_notes,p_idempotency_key',
} as const

const lote3 = leer(`${MIGRACIONES}/${LOTE3}`)

/** Fila del mapa de autoridad de Lote 3 para una RPC. */
function filaLote3(fn: string): string {
  const inicio = lote3.indexOf(`('${fn}'`)
  expect(inicio, `${fn} no está en el mapa de Lote 3`).toBeGreaterThan(0)
  const fin = lote3.indexOf('\n(', inicio + 1)
  return lote3.slice(inicio, fin === -1 ? undefined : fin)
}

/**
 * Cuerpo (`prosrc`) que el `format()` de Lote 3 produce para una RPC. Se arma
 * desde la plantilla REAL de la migración, no desde una copia en el test.
 */
function cuerpoDelWrapper(fn: string, args: string): string {
  const plantilla = lote3.match(/AS \$wrapper\$([\s\S]*?)\$wrapper\$/)
  expect(plantilla, 'no se encontró la plantilla del wrapper').not.toBeNull()
  let i = 0
  // Orden de los argumentos de format(): business_expr, capability,
  // additional_capability, required_feature, function_name, call_args.
  const valores = ['p_business_id', `'finance'`, 'NULL', 'NULL', fn, args]
  return plantilla![1].replace(/%[sLI]/g, () => valores[i++])
}

// ═══════════════════════════════════════════════════════════════════════════
describe('A · el wrapper efectivo exige `finance`', () => {
  for (const fn of Object.keys(RPCS)) {
    it(`${fn} está mapeada a la capacidad finance, acotada a p_business_id`, () => {
      const fila = filaLote3(fn)
      // …, business_expr, capability, additional_capability, volatility, service_execute
      expect(fila).toMatch(/'p_business_id','finance',NULL,'VOLATILE',true\)/)
    })
  }

  it('el wrapper autoriza ANTES de delegar en la implementación privada', () => {
    const cuerpo = cuerpoDelWrapper('open_cash_session_atomic', RPCS.open_cash_session_atomic)
    const iGate = cuerpo.indexOf(`PERFORM private.require_action_authority(p_business_id, 'finance', NULL, NULL);`)
    const iImpl = cuerpo.indexOf('RETURN private.open_cash_session_atomic(')
    expect(iGate).toBeGreaterThan(0)
    expect(iImpl).toBeGreaterThan(iGate)
  })

  it('la implementación privada no es ejecutable por el navegador', () => {
    expect(lote3).toMatch(/'ALTER FUNCTION public\.%I\(%s\) SET SCHEMA private'/)
    expect(lote3).toMatch(/'REVOKE ALL ON FUNCTION private\.%I\(%s\) FROM PUBLIC, anon, authenticated, service_role'/)
  })

  it('sin autoridad el gate LEVANTA 42501 `FORBIDDEN` (definición vigente: fase B)', () => {
    const gate = leer(`${MIGRACIONES}/${LOTE3_B}`)
    const def = gate.slice(gate.indexOf('CREATE OR REPLACE FUNCTION private.require_action_authority('))
    expect(def.slice(0, def.indexOf('$function$;'))).toMatch(
      /IF private\.has_action_authority\([\s\S]*?\) IS NOT TRUE THEN\s+RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';/)
    // Y la decisión usa la capacidad canónica, la misma que `canUseCaja`.
    expect(gate).toMatch(/RETURN public\.current_user_can\(p_capability\) IS TRUE/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · ninguna migración posterior redefine las RPC de caja', () => {
  it('después de Lote 3 nadie vuelve a crear, mover o conceder open/close_cash_session_atomic', () => {
    const posteriores = readdirSync(join(raiz, MIGRACIONES))
      .filter(f => f.endsWith('.sql') && f > LOTE3)
      .sort()
    expect(posteriores.length, 'no se leyeron migraciones posteriores').toBeGreaterThan(10)

    const reincidentes = posteriores.filter(f => {
      const sql = leer(`${MIGRACIONES}/${f}`).replace(/--.*$/gm, '')
      return /\b(open|close)_cash_session_atomic\b/.test(sql)
    })
    // Si esto falla: alguien tocó la autoridad de la caja. No se actualiza la
    // lista a ciegas — se rehace el discovery y se decide si el POS sigue bien.
    expect(reincidentes).toEqual([])
  })

  it('la versión de julio existe y NO tiene el gate: por eso importa cuál es la efectiva', () => {
    const m6 = leer(`${MIGRACIONES}/${M6}`)
    const def = m6.slice(m6.indexOf('CREATE OR REPLACE FUNCTION "public"."open_cash_session_atomic"('), m6.indexOf('-- ── close_cash_session_atomic'))
    expect(def).toMatch(/Sin acceso a este negocio/)
    expect(def).not.toMatch(/current_user_can|require_action_authority/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · producción sirve el wrapper, no la implementación de julio', () => {
  const catalogo = JSON.parse(leer('docs/security-sec08f/production-catalog.json')) as {
    catalog: { checked_at: string; security_definer_functions: Array<{
      name: string; body_md5: string; config: string[]
      anon_execute: boolean; authenticated_execute: boolean; service_execute: boolean
    }> }
  }
  const funciones = catalogo.catalog.security_definer_functions

  for (const [fn, args] of Object.entries(RPCS)) {
    it(`${fn}: el cuerpo en producción es EXACTAMENTE el del wrapper gateado`, () => {
      const entradas = funciones.filter(f => f.name === fn)
      expect(entradas, `${fn} debería aparecer una sola vez en public`).toHaveLength(1)
      const prod = entradas[0]
      expect(prod.body_md5).toBe(md5(cuerpoDelWrapper(fn, args)))
      expect(prod.config).toEqual(['search_path=pg_catalog, pg_temp'])
      expect(prod.anon_execute).toBe(false)
      expect(prod.authenticated_execute).toBe(true)
    })
  }

  it('el snapshot es posterior al despliegue de Lote 3', () => {
    expect(new Date(catalogo.catalog.checked_at).getTime())
      .toBeGreaterThan(new Date('2026-09-08T00:00:00Z').getTime())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · la matriz SQL existente ya prueba permitido / denegado', () => {
  const matriz = leer('tests/sql/lote3_action_write_authority.test.sql')

  for (const fn of Object.keys(RPCS)) {
    it(`${fn} es un caso de la matriz, con capacidad finance`, () => {
      expect(matriz).toContain(`('${fn}','finance',NULL,`)
    })
  }

  it('cada caso prueba: inactivo, sin perfil, sin capacidad, override false, otro tenant, y la matriz de roles', () => {
    for (const control of [
      `c.function_name||' inactive'`,
      `c.function_name||' no profile'`,
      `c.function_name||' missing capability'`,
      `c.function_name||' explicit false override'`,
      `c.function_name||' foreign tenant'`,
      `c.function_name||' role matrix '`,
    ]) expect(matriz, control).toContain(control)
    // `sales` y el override positivo (`tech_true`) están en la matriz de roles,
    // y lo esperado se deriva de `current_user_can`, no de una lista de roles.
    expect(matriz).toMatch(/ARRAY\['owner','admin','manager','tech','sales','cashier','viewer','tech_true'\]/)
    expect(matriz).toMatch(/'SELECT to_jsonb\(public\.current_user_can\(%L\)/)
    // Y cada denegación exige CERO efectos sobre las tablas financieras.
    expect(matriz).toContain(`label||' ZERO EFFECTS'`)
    expect(matriz).toMatch(/FOREACH t IN ARRAY ARRAY\[\s*'cajas',/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E · el texto de la carrera es el del servidor', () => {
  it('`CAJA_ALREADY_OPEN_ERROR` es el literal que devuelve la implementación, en sus dos salidas', () => {
    const m6 = leer(`${MIGRACIONES}/${M6}`)
    const def = m6.slice(m6.indexOf('CREATE OR REPLACE FUNCTION "public"."open_cash_session_atomic"('), m6.indexOf('-- ── close_cash_session_atomic'))
    const salidas = def.match(new RegExp(`'error', '${CAJA_ALREADY_OPEN_ERROR}'`, 'g')) ?? []
    // 1) chequeo previo  2) unique_violation del índice único parcial
    expect(salidas).toHaveLength(2)
    expect(def).toMatch(/EXCEPTION WHEN unique_violation THEN\s+RETURN jsonb_build_object\('ok', false, 'error', 'Ya hay una caja abierta'\);/)
  })

  it('y está fijado por tests SQL del servidor (CS4 de M6 y la matriz de este lote)', () => {
    expect(leer('supabase/tests/etapa6_cash_sessions_test.sql'))
      .toMatch(/r->>'error' ILIKE '%Ya hay una caja abierta%', 'CS4/)
    expect(leer('tests/sql/beta_ux_1b_cash_session_authority.test.sql'))
      .toContain(`r->>'ok' = 'false' AND r->>'error' = '${CAJA_ALREADY_OPEN_ERROR}'`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('F · la matriz SQL de este lote existe, es transaccional y trae su control negativo', () => {
  const sql = leer('tests/sql/beta_ux_1b_cash_session_authority.test.sql')
  const sinComentarios = sql.replace(/--.*$/gm, '')

  it('empieza en BEGIN y termina en ROLLBACK: no deja nada en la base', () => {
    expect(sinComentarios.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(sinComentarios.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    expect(sinComentarios).not.toMatch(/^\s*COMMIT\s*;/m)
  })

  it('cubre abrir y cerrar, la tabla del producto y las denegaciones con cero efectos', () => {
    expect(sql).toContain(`con_finance text[] := ARRAY['owner','admin','cashier','tech_true','sales_true']`)
    for (const actor of ['manager', 'tech', 'sales', 'viewer', 'admin_false', 'cashier_false', 'inactive', 'no_profile', 'ownerB']) {
      expect(sql, actor).toContain(`'${actor}'`)
    }
    expect(sql).toContain('public.open_cash_session_atomic(')
    expect(sql).toContain('public.close_cash_session_atomic(')
    expect(sql).toMatch(/result->>'sqlstate' = '42501' AND result->>'message' = 'FORBIDDEN'/)
    expect(sql).toContain('CERO efectos')
  })

  it('el control negativo quita el gate y exige que `sales` SÍ pase', () => {
    expect(sql).toContain('SAVEPOINT sin_gate;')
    expect(sql).toContain('ROLLBACK TO SAVEPOINT sin_gate;')
    expect(sql).toMatch(/control negativo: sin el gate, sales debería poder abrir la caja/)
  })

  it('tiene su script de npm', () => {
    const pkg = JSON.parse(leer('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:sql:beta-ux-1b']).toContain('tests/sql/beta_ux_1b_cash_session_authority.test.sql')
    expect(pkg.scripts['test:beta-ux-1b']).toContain('tests/components/betaUx1bServerAuthority.test.ts')
  })
})
