#!/usr/bin/env node
// ============================================================================
// P0 FIRST-STEPS-1 — guard de CI del checklist derivado.
//
// Falla (exit 1) si alguien reintroduce alguno de los defectos que este lote
// cierra:
//
//   1. localStorage como FUENTE de completitud (`onboarding_done_*`, toggles).
//   2. La RPC recibiendo un `business_id` del cliente.
//   3. Grants a `anon`/`PUBLIC` sobre `get_my_first_steps()`.
//   4. La RPC contando egresos, SaaS o `amount_paid` como cobro.
//   5. La RPC filtrando por `replaced_at`/`reversed_at` (rompe §19).
//   6. Dos implementaciones vivas del mismo checklist.
//
//   node scripts/guards/first-steps-derived.mjs [--self-test]
// ============================================================================
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RAIZ = resolve(process.argv[2] ?? '.')

const MIGRACION = 'supabase/migrations/20260905120000_first_steps_derived.sql'
const SERVICIO  = 'src/services/firstStepsService.ts'
const HOOK      = 'src/hooks/useFirstSteps.ts'
const CONTENEDOR= 'src/components/onboarding/FirstStepsChecklist.tsx'
const PRESENTA  = 'src/components/onboarding/SetupChecklist.tsx'
const RETIRADO  = 'src/components/onboarding/OnboardingChecklist.tsx'

const leer = (raiz, rel) => {
  const p = join(raiz, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** Quita comentarios SQL y de JS para no analizar prosa. */
function sinComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

export function revisar(raiz) {
  const h = []
  const sql  = leer(raiz, MIGRACION)
  const svc  = leer(raiz, SERVICIO)
  const hook = leer(raiz, HOOK)
  const cont = leer(raiz, CONTENEDOR)
  const pres = leer(raiz, PRESENTA)

  // ── 0. Presencia ──────────────────────────────────────────────────────────
  if (!sql)  h.push(`falta la migracion ${MIGRACION}`)
  if (!svc)  h.push(`falta el servicio ${SERVICIO}`)
  if (!hook) h.push(`falta el hook ${HOOK}`)
  if (!cont) h.push(`falta el contenedor ${CONTENEDOR}`)

  // ── 6. Una sola implementacion del checklist ──────────────────────────────
  if (existsSync(join(raiz, RETIRADO))) {
    h.push(`${RETIRADO} volvio: hay DOS implementaciones del mismo checklist`)
  }

  if (sql) {
    const s = sinComentarios(sql)

    // ── 2. Firma sin parametros ─────────────────────────────────────────────
    const firma = s.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.get_my_first_steps\s*\(([^)]*)\)/i)
    if (!firma) {
      h.push('la migracion no define public.get_my_first_steps()')
    } else if (firma[1].trim() !== '') {
      h.push(`get_my_first_steps() acepta parametros (${firma[1].trim()}): el tenant debe derivarse server-side`)
    }

    // ── 3. Grants ───────────────────────────────────────────────────────────
    if (/GRANT\s+[^;]*\bON\s+FUNCTION\s+public\.get_my_first_steps[^;]*\bTO\s+[^;]*\banon\b/i.test(s)) {
      h.push('GRANT a anon sobre get_my_first_steps(): la RPC es solo para authenticated')
    }
    if (/GRANT\s+[^;]*\bON\s+FUNCTION\s+public\.get_my_first_steps[^;]*\bTO\s+PUBLIC\b/i.test(s)) {
      h.push('GRANT a PUBLIC sobre get_my_first_steps()')
    }
    if (!/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.get_my_first_steps\s*\(\s*\)\s+FROM\s+PUBLIC/i.test(s)) {
      h.push('falta REVOKE ... FROM PUBLIC (EXECUTE a PUBLIC es el default de PostgreSQL)')
    }
    if (!/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.get_my_first_steps\s*\(\s*\)\s+TO\s+authenticated/i.test(s)) {
      h.push('falta GRANT EXECUTE a authenticated')
    }

    // ── search_path endurecido ──────────────────────────────────────────────
    if (!/SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp/i.test(s)) {
      h.push('search_path no endurecido (se espera: pg_catalog, public, pg_temp)')
    }

    // El cuerpo de la funcion, para las reglas semanticas.
    const cuerpo = (s.split(/AS\s+\$function\$/i)[1] ?? '').split(/\$function\$/)[0]

    // ── 4. Que NO cuenta como cobro ─────────────────────────────────────────
    for (const [re, msg] of [
      [/\bfinancial_movements\b/i,   'la RPC lee financial_movements: incluye egresos y aperturas de caja, no son cobros'],
      [/\bsubscription_payments\b/i, 'la RPC lee subscription_payments: es el SaaS cobrandole al comerciante'],
      [/\bfrom\s+public\.payments\b/i, 'la RPC lee public.payments: son pagos del SaaS, no cobros del negocio'],
      [/\bamount_paid\b/i,           'la RPC lee amount_paid: es un campo manual, no un asiento canonico'],
      [/\bcajas?\b/i,                'la RPC mira Caja: abrir caja no es cobrar'],
    ]) {
      if (re.test(cuerpo)) h.push(msg)
    }

    // ── 5. Monotonicidad del cobro (§19) ────────────────────────────────────
    for (const col of ['replaced_at', 'reversed_at']) {
      if (new RegExp(`\\b${col}\\b`, 'i').test(cuerpo)) {
        h.push(`la RPC filtra por ${col}: un cobro reversado dejaria de contar y la tarea volveria a pendiente (§19)`)
      }
    }

    // ── El cobro debe seguir mirando las tres fuentes canonicas ─────────────
    for (const t of ['comprobante_payments', 'order_payments', 'account_movements']) {
      if (!new RegExp(`\\b${t}\\b`).test(cuerpo)) {
        h.push(`la RPC ya no lee ${t}: se perdio una fuente canonica de cobro`)
      }
    }
    if (!/\bcredit\s*>\s*0/i.test(cuerpo)) {
      h.push('la cobranza de cuenta corriente ya no exige credit > 0 (un debit es un cargo, no un cobro)')
    }

    // ── Doble fuente de logo durante la transicion con ONBOARDING-1 ─────────
    if (!/businesses\b[\s\S]*logo_url/i.test(cuerpo) || !/business_settings\b[\s\S]*logo_url/i.test(cuerpo)) {
      h.push('el logo debe aceptar businesses.logo_url O business_settings.logo_url durante la transicion')
    }

    // ── Tenant derivado server-side ────────────────────────────────────────
    if (!/current_user_business_id\s*\(\s*\)/i.test(cuerpo)) {
      h.push('la RPC no deriva el tenant con current_user_business_id()')
    }

    // ── EXISTS, no COUNT (§16) ─────────────────────────────────────────────
    if (/\bcount\s*\(/i.test(cuerpo)) {
      h.push('la RPC usa COUNT: se pide EXISTS (corta en la primera fila)')
    }
  }

  // ── 2b. El frontend no manda business_id ─────────────────────────────────
  if (svc) {
    const s = sinComentarios(svc)
    const call = s.match(/\.rpc\(\s*['"]get_my_first_steps['"]\s*(,[^)]*)?\)/)
    if (!call) {
      h.push('el servicio no invoca la RPC get_my_first_steps')
    } else if (call[1] && call[1].trim() !== ',' && call[1].trim() !== '') {
      h.push(`la RPC se invoca con argumentos (${call[1].trim()}): el cliente no debe elegir el tenant`)
    }
    if (/\bbusiness_?[iI]d\b/.test(s)) {
      h.push('el servicio maneja un businessId: la lectura no debe parametrizarse por tenant')
    }
  }

  // ── 1. localStorage nunca como fuente de completitud ─────────────────────
  for (const [rel, txt] of [[HOOK, hook], [CONTENEDOR, cont], [PRESENTA, pres]]) {
    if (!txt) continue
    const s = sinComentarios(txt)
    if (/onboarding_done_/.test(s)) {
      h.push(`${rel}: reaparecio la clave onboarding_done_* (era la fuente de completitud vieja)`)
    }
    // Sólo se tolera la clave de preferencia de UI.
    const claves = [...s.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*([^)]*)\)/g)].map(m => m[1])
    for (const k of claves) {
      if (!/dismissKey|first_steps_dismissed_/.test(k)) {
        h.push(`${rel}: localStorage con clave no permitida (${k.trim()}); solo se admite first_steps_dismissed_*`)
      }
    }
  }

  if (pres) {
    const s = sinComentarios(pres)
    if (/type\s*=\s*["']checkbox["']/.test(s) || /role\s*=\s*["']checkbox["']/.test(s)) {
      h.push(`${PRESENTA}: el indicador volvio a ser un checkbox; debe ser solo visual`)
    }
  }

  return h
}

// ── self-test: rompe el codigo a proposito y verifica que el guard lo vea ────
function selfTest() {
  const base = resolve('.')
  const casos = [
    ['firma con business_id', MIGRACION,
      t => t.replace('FUNCTION public.get_my_first_steps()', 'FUNCTION public.get_my_first_steps(p_business_id uuid)')],
    ['GRANT a anon', MIGRACION,
      t => t + '\nGRANT EXECUTE ON FUNCTION public.get_my_first_steps() TO anon;\n'],
    ['sin REVOKE de PUBLIC', MIGRACION,
      t => t.replace(/REVOKE ALL ON FUNCTION public\.get_my_first_steps\(\) FROM PUBLIC;/, '')],
    ['cuenta egresos como cobro', MIGRACION,
      t => t.replace('FROM public.order_payments op, biz', 'FROM public.financial_movements op, biz')],
    ['filtra por reversed_at', MIGRACION,
      t => t.replace('WHERE op.business_id = biz.id', 'WHERE op.business_id = biz.id AND op.reversed_at IS NULL')],
    ['clave vieja de localStorage', HOOK,
      t => t.replace(/first_steps_dismissed_/g, 'onboarding_done_')],
    ['RPC con argumentos', SERVICIO,
      t => t.replace(".rpc('get_my_first_steps')", ".rpc('get_my_first_steps', { p_business_id: 'x' })")],
  ]

  let fallas = 0
  // Control: el arbol real debe estar limpio.
  const limpio = revisar(base)
  if (limpio.length) {
    console.error('self-test: el arbol REAL ya tiene hallazgos:', limpio)
    fallas++
  }

  for (const [nombre, rel, mutar] of casos) {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-'))
    try {
      // Copia mínima: solo los archivos que el guard mira.
      for (const f of [MIGRACION, SERVICIO, HOOK, CONTENEDOR, PRESENTA]) {
        const src = join(base, f)
        if (!existsSync(src)) continue
        const dst = join(dir, f)
        mkdirSync(join(dst, '..'), { recursive: true })
        writeFileSync(dst, readFileSync(src, 'utf8'))
      }
      const objetivo = join(dir, rel)
      writeFileSync(objetivo, mutar(readFileSync(objetivo, 'utf8')))

      const hallazgos = revisar(dir)
      if (hallazgos.length === 0) {
        console.error(`self-test FALLA: "${nombre}" no fue detectado`)
        fallas++
      } else {
        console.log(`  ok  detecta: ${nombre}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  if (fallas) { console.error(`\nself-test: ${fallas} caso(s) fallaron`); process.exit(1) }
  console.log('Guard FIRST-STEPS-1 self-test OK')
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const hallazgos = revisar(RAIZ)
  if (hallazgos.length) {
    console.error('Guard FIRST-STEPS-1: hallazgos\n')
    for (const x of hallazgos) console.error('  - ' + x)
    process.exit(1)
  }
  console.log('Guard FIRST-STEPS-1 OK: checklist derivado del servidor, RPC sin parametros, grants acotados.')
}
