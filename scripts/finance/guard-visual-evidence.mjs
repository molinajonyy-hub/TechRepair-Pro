#!/usr/bin/env node
// ============================================================================
// M7 7D.3 — Guard: la evidencia visual trackeada no se regraba sola.
//
// Los specs @visual escriben PNGs en docs/auditoria-finanzas/m7/evidencia-7d2/.
// Antes lo hacían en CADA corrida, así que el árbol quedaba sucio con bytes
// distintos y contenido equivalente. Con el árbol siempre sucio, `git status`
// deja de ser señal: un cambio real se pierde entre el ruido.
//
// Este guard corre DESPUES de los E2E y falla si esos PNGs quedaron
// modificados sin que se haya pedido regrabarlos explícitamente.
//
//   node scripts/finance/guard-visual-evidence.mjs
//   node scripts/finance/guard-visual-evidence.mjs --self-test
// ============================================================================

import { execFileSync } from 'node:child_process'

const DIR = 'docs/auditoria-finanzas/m7/evidencia-7d2'

/**
 * Predicado puro (testeable sin git): dada la salida de `git status --porcelain`,
 * ¿qué archivos de evidencia quedaron modificados?
 */
export function evidenciaModificada(porcelain, dir = DIR) {
  return porcelain
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    // El path es todo lo que sigue al código de estado de 2 chars.
    .map(l => l.slice(2).trim().replace(/^"|"$/g, ''))
    .filter(p => p.startsWith(dir))
}

function selfTest() {
  const casos = [
    { nombre: 'árbol limpio', in: '', esperado: 0 },
    {
      nombre: 'un PNG de evidencia modificado',
      in: ` M ${DIR}/health-check-desktop-dark.png`,
      esperado: 1,
    },
    {
      nombre: 'los cuatro modificados',
      in: [` M ${DIR}/health-check-desktop-dark.png`, ` M ${DIR}/health-check-desktop-light.png`,
           ` M ${DIR}/health-check-mobile-dark.png`, ` M ${DIR}/health-check-mobile-light.png`].join('\n'),
      esperado: 4,
    },
    {
      nombre: 'cambios ajenos NO cuentan',
      in: ' M src/pages/CajaPage.tsx\n M package.json',
      esperado: 0,
    },
    {
      nombre: 'un PNG nuevo (untracked) también cuenta',
      in: `?? ${DIR}/health-check-nuevo.png`,
      esperado: 1,
    },
  ]
  let fallos = 0
  for (const c of casos) {
    const got = evidenciaModificada(c.in).length
    const ok = got === c.esperado
    if (!ok) fallos++
    console.log(`${ok ? '✅' : '❌'} fixture "${c.nombre}": esperaba ${c.esperado}, obtuvo ${got}`)
  }
  if (fallos) { console.error(`\n❌ self-test: ${fallos} fixture(s) fallaron`); process.exit(1) }
  console.log('\n✅ self-test: las 5 fixtures se clasifican correctamente')
}

if (process.argv.includes('--self-test')) { selfTest(); process.exit(0) }

const porcelain = execFileSync('git', ['status', '--porcelain', '--', DIR], { encoding: 'utf8' })
const sucios = evidenciaModificada(porcelain)

if (sucios.length) {
  console.error('❌ Guard de evidencia visual: hay capturas modificadas sin pedirlo.\n')
  sucios.forEach(f => console.error(`   ${f}`))
  console.error(`
Una corrida normal de E2E NO debe reescribir la evidencia trackeada.
Si el cambio visual es REAL y querés dejarlo asentado:

    npm run e2e:m7:evidencia     # regraba las capturas a propósito

Si no lo es, descartalo:

    git checkout -- ${DIR}/
`)
  process.exit(1)
}

console.log('✅ Guard de evidencia visual OK: la corrida no reescribió capturas trackeadas.')
