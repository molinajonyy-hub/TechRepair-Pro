#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// G2-A · Guard del contrato del POS para beta.
//
// Fija en el CÓDIGO cuatro decisiones de producto que un cambio inocente puede
// revertir sin que ningún test de render se entere:
//
//   1. El POS abre en Nota de Pedido (`remito`), no en Factura C.
//   2. Factura A no es alcanzable desde el selector de beta.
//   3. `emitir_en_arca` se DERIVA del tipo; no hay checkbox que permita
//      construir `factura_c + emitir_en_arca=false`.
//   4. La autorización fiscal no se infiere de `estado === 'emitido'`.
//
// `--self-test` muta cada invariante en memoria y exige que el guard lo detecte:
// un guard que no puede fallar no prueba nada.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'

const POS    = 'src/components/comprobantes/ComprobanteProModal.tsx'
const STATUS = 'src/utils/comprobanteStatus.ts'
const LABEL  = 'src/lib/comprobanteTipoLabel.ts'

const read = (p) => readFileSync(p, 'utf8')

// ── Checks sobre el POS ──────────────────────────────────────────────────────

function inspectPos(text) {
  const findings = []

  // 1. Default.
  if (!/const\s+TIPO_POS_DEFAULT\s*:\s*TipoPosGenerico\s*=\s*'remito'/.test(text)) {
    findings.push('el default del POS dejó de ser `remito` (Nota de Pedido)')
  }
  // El default viejo no puede volver por la puerta de atrás del `??`.
  if (/tipoInicial\s*\?\?\s*'factura_c'/.test(text)) {
    findings.push('reapareció `tipoInicial ?? \'factura_c\'`: el POS volvería a abrir en Factura C')
  }

  // 2. Factura A fuera del selector.
  const selector = text.match(/const\s+TIPOS_POS_GENERICOS\s*=\s*\[([^\]]*)\]/)
  if (!selector) {
    findings.push('no se encontró TIPOS_POS_GENERICOS')
  } else {
    if (selector[1].includes('factura_a')) {
      findings.push('`factura_a` volvió al selector del POS (fuera de beta)')
    }
    if (!selector[1].includes('remito')) {
      findings.push('`remito` no está en el selector del POS')
    }
  }

  // 3. `emitir_en_arca` derivado, sin checkbox.
  if (!/const\s+emitirEnArca\s*=\s*esTipoFiscal\(tipo\)/.test(text)) {
    findings.push('`emitirEnArca` dejó de derivarse del tipo')
  }
  if (/setEmitirEnArca/.test(text)) {
    findings.push('volvió un setter de `emitirEnArca`: se puede desacoplar del tipo')
  }
  if (/type=["']checkbox["'][^>]*emitirEnArca/.test(text) || /emitirEnArca[^)]*type=["']checkbox["']/.test(text)) {
    findings.push('volvió el checkbox de ARCA: permite `factura_c + emitir_en_arca=false`')
  }

  return findings
}

// ── Checks sobre la autoridad de estado fiscal ───────────────────────────────

function inspectStatus(text) {
  const findings = []

  // El defecto G2-P1-A, por su forma exacta: `estado === 'emitido'` usado como
  // evidencia de autorización fiscal.
  const ramaArca = text.match(/if\s*\(\s*c\.cae[^)]*\)\s*\{\s*\n\s*return\s+construir\('emitido_arca'/)
  if (!ramaArca) {
    findings.push('no se encontró la rama `emitido_arca` con la forma esperada')
  } else if (/c\.estado\s*===\s*'emitido'/.test(ramaArca[0])) {
    findings.push('`estado === \'emitido\'` volvió a contar como autorización de ARCA (G2-P1-A)')
  }

  if (!/esComprobanteNoFiscal/.test(text)) {
    findings.push('desapareció `esComprobanteNoFiscal`: nada distingue un documento interno')
  }
  if (!/key\s*!==\s*'no_fiscal'/.test(text)) {
    findings.push('`no_fiscal` dejó de estar excluido de las acciones de emisión')
  }
  return findings
}

// ── Check del rótulo ─────────────────────────────────────────────────────────

function inspectLabel(text) {
  const findings = []
  if (!/remito:\s*'Nota de Pedido'/.test(text)) {
    findings.push('`remito` dejó de rotularse «Nota de Pedido»')
  }
  // Se busca una CLAVE real (`nota_pedido:` o `'nota_pedido'`), no la palabra
  // suelta: el módulo la menciona en prosa al documentar por qué NO se creó.
  if (/nota_pedido\s*:/.test(text) || /['"]nota_pedido['"]/.test(text)) {
    findings.push('apareció un tipo `nota_pedido`: este lote NO cambia el dominio de DB')
  }
  return findings
}

// ── Runner ───────────────────────────────────────────────────────────────────

function run(sources) {
  return [
    ...inspectPos(sources.pos).map(f => `${POS}: ${f}`),
    ...inspectStatus(sources.status).map(f => `${STATUS}: ${f}`),
    ...inspectLabel(sources.label).map(f => `${LABEL}: ${f}`),
  ]
}

function loadSources() {
  return { pos: read(POS), status: read(STATUS), label: read(LABEL) }
}

// ── Self-test: cada mutación tiene que ser detectada ─────────────────────────

function selfTest() {
  const base = loadSources()
  const limpio = run(base)
  if (limpio.length) {
    console.error('SELF-TEST FALLÓ: el árbol actual ya viola el contrato:')
    limpio.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }

  const MUTACIONES = [
    ['default vuelve a Factura C',
      s => ({ ...s, pos: s.pos.replace(/TIPO_POS_DEFAULT\s*:\s*TipoPosGenerico\s*=\s*'remito'/, "TIPO_POS_DEFAULT: TipoPosGenerico = 'factura_c'") })],
    ['default viejo por la puerta de atrás',
      s => ({ ...s, pos: s.pos.replace(/tipoInicial \?\? TIPO_POS_DEFAULT/, "tipoInicial ?? 'factura_c'") })],
    ['Factura A vuelve al selector',
      s => ({ ...s, pos: s.pos.replace(/const TIPOS_POS_GENERICOS = \['remito', 'factura_c'\]/, "const TIPOS_POS_GENERICOS = ['factura_a', 'remito', 'factura_c']") })],
    ['emitirEnArca deja de derivarse',
      s => ({ ...s, pos: s.pos.replace(/const emitirEnArca = esTipoFiscal\(tipo\)/, 'const [emitirEnArca, setEmitirEnArca] = useState(false)') })],
    ['vuelve el checkbox de ARCA',
      s => ({ ...s, pos: s.pos.replace(/<span data-testid="pos-arca-aviso"/, '<input type="checkbox" checked={emitirEnArca} /><span data-testid="pos-arca-aviso"') })],
    ['`estado=emitido` vuelve a probar ARCA',
      s => ({ ...s, status: s.status.replace(/if \(c\.cae \|\| c\.estado_fiscal === 'emitido'\) \{/, "if (c.cae || c.estado_fiscal === 'emitido' || c.estado === 'emitido') {") })],
    ['`no_fiscal` vuelve a permitir emisión',
      s => ({ ...s, status: s.status.replace(/\s*&& key !== 'no_fiscal'/, '') })],
    ['el rótulo vuelve a «Remito»',
      s => ({ ...s, label: s.label.replace(/remito:\s*'Nota de Pedido'/, "remito:       'Remito'") })],
  ]

  let fallos = 0
  for (const [nombre, mutar] of MUTACIONES) {
    const mutado = mutar(base)
    const sinCambios = JSON.stringify(mutado) === JSON.stringify(base)
    const detectado = run(mutado).length > 0
    if (sinCambios) {
      console.error(`  ✖ ${nombre}: la mutación no aplicó (el patrón cambió) — el self-test estaría mintiendo`)
      fallos++
    } else if (!detectado) {
      console.error(`  ✖ ${nombre}: NO detectado`)
      fallos++
    } else {
      console.log(`  ✔ ${nombre}: detectado`)
    }
  }
  if (fallos) {
    console.error(`SELF-TEST FALLÓ: ${fallos} mutación(es) no detectada(s).`)
    process.exit(1)
  }
  console.log('SELF-TEST OK: las 8 mutaciones del contrato G2-A son detectadas.')
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const findings = run(loadSources())
  if (findings.length) {
    console.error('GUARD G2-A FALLÓ — el contrato del POS de beta está roto:')
    findings.forEach(f => console.error('  · ' + f))
    process.exit(1)
  }
  console.log('GUARD G2-A OK · default Nota de Pedido · Factura A fuera del selector · ARCA derivado del tipo · sin inferencia por `estado`.')
}
