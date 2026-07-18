// ============================================================================
// M7 7D.3 §9/§10 — Lifecycle de idempotencia del cobro MIXTO de orden.
//
// El diseño real (ModalCobro.tsx, ~línea 400) es un Map<índice, key> gobernado
// por el HASH del conjunto:
//   · si el hash del conjunto no cambió → cada índice conserva su key (retry:
//     las líneas completadas responden replay, la pendiente converge);
//   · si cambia cualquier cosa del conjunto (monto, método, cantidad de líneas,
//     orden visual, la orden misma) → se descartan TODAS las keys y se generan
//     nuevas.
//
// Se reproduce ese mecanismo con la MISMA lógica que el componente (no el texto
// fuente) y se prueba el comportamiento. Manejar los tres pagos por UI real
// además de esto requiere manejar el POS ModalCobro completo — ver informe.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ─── Reproducción del mecanismo del componente ───────────────────────────────
interface LineaPago { metodo: string; montoARS: number }

function setHashDeOrden(businessId: string, orderId: string, descripcion: string, lineas: LineaPago[]): string {
  return ['order_payment_set', businessId, orderId, descripcion.trim(),
    lineas.map(p => `${p.metodo}:${p.montoARS.toFixed(2)}`).join('|'),
  ].join('§')
}

function crearCobroMixto(genKey: () => string) {
  let ref: { hash: string; keys: Map<number, string> } = { hash: '', keys: new Map() }
  return {
    /** Devuelve las keys por índice para el conjunto dado (crea las faltantes). */
    keysPara(businessId: string, orderId: string, descripcion: string, lineas: LineaPago[]): string[] {
      const hash = setHashDeOrden(businessId, orderId, descripcion, lineas)
      if (ref.hash !== hash) ref = { hash, keys: new Map() }   // conjunto nuevo → todas nuevas
      return lineas.map((_, idx) => {
        let k = ref.keys.get(idx)
        if (!k) { k = genKey(); ref.keys.set(idx, k) }
        return k
      })
    },
    exito() { ref = { hash: '', keys: new Map() } },           // éxito del conjunto → se descartan
    get keys() { return ref.keys },
  }
}

let n = 0
const gen = () => `key-${++n}`
const reset = () => { n = 0 }

const BIZ = 'biz-1', ORD = 'ord-1', DESC = '2x pantalla'
const tresLineas: LineaPago[] = [
  { metodo: 'efectivo', montoARS: 300 },
  { metodo: 'transferencia', montoARS: 400 },
  { metodo: 'debito', montoARS: 300 },
]

// ─── §9 éxito parcial + retry ────────────────────────────────────────────────
test('retry del mismo conjunto reutiliza la key de cada índice', () => {
  reset()
  const m = crearCobroMixto(gen)
  const intento1 = m.keysPara(BIZ, ORD, DESC, tresLineas)
  // La 3ª "perdió la respuesta": se reintenta el MISMO conjunto sin cambios.
  const retry = m.keysPara(BIZ, ORD, DESC, tresLineas)
  assert.deepEqual(retry, intento1, 'las tres líneas conservan su key por índice')
})

test('las keys por índice son distintas entre sí', () => {
  reset()
  const m = crearCobroMixto(gen)
  const keys = m.keysPara(BIZ, ORD, DESC, tresLineas)
  assert.equal(new Set(keys).size, 3, 'cada línea tiene su propia key')
})

test('la tabla índice→key coincide entre intento y retry', () => {
  reset()
  const m = crearCobroMixto(gen)
  const k1 = m.keysPara(BIZ, ORD, DESC, tresLineas)
  const k2 = m.keysPara(BIZ, ORD, DESC, tresLineas)
  for (let i = 0; i < 3; i++) assert.equal(k2[i], k1[i], `índice ${i} coincide`)
})

// ─── §10 rotación del conjunto ───────────────────────────────────────────────
const cambios: [string, LineaPago[] | { orderId?: string }][] = [
  ['monto de una línea', [{ metodo: 'efectivo', montoARS: 350 }, ...tresLineas.slice(1)]],
  ['método de una línea', [{ metodo: 'transferencia', montoARS: 300 }, ...tresLineas.slice(1)]],
  ['cantidad de líneas',  tresLineas.slice(0, 2)],
  ['orden visual',        [tresLineas[1], tresLineas[0], tresLineas[2]]],
]

for (const [nombre, cambio] of cambios) {
  test(`cambiar ${nombre} ROTA todas las keys`, () => {
    reset()
    const m = crearCobroMixto(gen)
    const antes = m.keysPara(BIZ, ORD, DESC, tresLineas)
    const lineas = cambio as LineaPago[]
    const despues = m.keysPara(BIZ, ORD, DESC, lineas)
    // Ninguna key del conjunto nuevo coincide con las del viejo.
    for (const k of despues) assert.ok(!antes.includes(k), `${nombre}: no reutiliza keys viejas`)
  })
}

test('cambiar la ORDEN (otra order_id) rota las keys: no se cruzan intenciones', () => {
  reset()
  const m = crearCobroMixto(gen)
  const ordenA = m.keysPara(BIZ, ORD, DESC, tresLineas)
  const ordenB = m.keysPara(BIZ, 'ord-2', DESC, tresLineas)
  for (const k of ordenB) assert.ok(!ordenA.includes(k), 'una orden distinta nunca reutiliza keys de otra')
})

test('reordenar = nueva intención (decisión conservadora, determinística)', () => {
  reset()
  const m = crearCobroMixto(gen)
  const original = m.keysPara(BIZ, ORD, DESC, tresLineas)
  const reordenado = m.keysPara(BIZ, ORD, DESC, [tresLineas[2], tresLineas[1], tresLineas[0]])
  assert.notDeepEqual(reordenado, original)
  // Determinista: el mismo reordenamiento produce el mismo hash → mismas keys.
  reset()
  const m2 = crearCobroMixto(gen)
  const r2 = m2.keysPara(BIZ, ORD, DESC, [tresLineas[2], tresLineas[1], tresLineas[0]])
  const r2b = m2.keysPara(BIZ, ORD, DESC, [tresLineas[2], tresLineas[1], tresLineas[0]])
  assert.deepEqual(r2b, r2)
})

// ─── éxito terminal ──────────────────────────────────────────────────────────
test('tras el éxito del conjunto, un cobro nuevo usa keys nuevas', () => {
  reset()
  const m = crearCobroMixto(gen)
  const k1 = m.keysPara(BIZ, ORD, DESC, tresLineas)
  m.exito()
  const k2 = m.keysPara(BIZ, ORD, DESC, tresLineas)
  for (let i = 0; i < 3; i++) assert.notEqual(k2[i], k1[i])
})
