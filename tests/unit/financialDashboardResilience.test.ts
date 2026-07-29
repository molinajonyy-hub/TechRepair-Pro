// ─────────────────────────────────────────────────────────────────────────────
// P0 Dashboard Resilience.
//
// Dos defectos, un solo lote:
//
//   1. Un error de consulta se convertía en $0. `(res.data || []).reduce(...)`
//      trata `null` (error) igual que "sin filas", así que un 403 se renderizaba
//      como un saldo cero perfectamente creíble.
//
//   2. `cajaKey` estaba en las deps del loader único. Como `activeCaja` arranca
//      en `null` y se resuelve async, al pasar a UUID se refetcheaba TODO,
//      incluidas consultas que no dependen de la caja.
//
// Estos tests EJECUTAN los loaders reales contra un puerto falso: no buscan
// strings en el código. El puerto además registra qué consultas se hicieron, que
// es exactamente lo que prueba el desacople.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadGeneral,
  loadCaja,
  aggregateCaja,
  sumVentas,
  toFinanceLoadError,
  financeErrorCode,
  FINANCE_PERMISSION_MESSAGE,
  FINANCE_UNAVAILABLE_MESSAGE,
  type FinanceDashboardPort,
  type MovimientoCajaRow,
} from '../../src/hooks/financialDashboardLoaders.ts'

const BIZ  = '00000000-0000-0000-0000-00000000fa01'
const CAJA = '00000000-0000-0000-0000-00000000fc01'
const WEEK  = '2026-07-21'
const MONTH = '2026-06-28'

// ── Puerto falso que registra cada llamada ───────────────────────────────────

interface Recorded { calls: string[] }

function makePort(
  overrides: Partial<FinanceDashboardPort> = {},
): FinanceDashboardPort & Recorded {
  const calls: string[] = []
  const port = {
    calls,
    ventasDesde: async (_b: string, since: string) => {
      calls.push(`ventasDesde:${since}`)
      return { data: [{ amount_ars: 1000 }, { amount_ars: 500 }], error: null }
    },
    stockBajo: async () => { calls.push('stockBajo'); return { data: 3, error: null } },
    movimientosCaja: async () => {
      calls.push('movimientosCaja')
      return {
        data: [
          { type: 'income',  amount_ars: 15000, metodo_pago: 'efectivo' },
          { type: 'expense', amount_ars: 2000,  metodo_pago: 'efectivo' },
        ] as MovimientoCajaRow[],
        error: null,
      }
    },
    ...overrides,
  }
  return port as FinanceDashboardPort & Recorded
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1 — un error NUNCA se convierte en cero
// ═════════════════════════════════════════════════════════════════════════════

test('T1a caja con 42501 → error, y NINGÚN valor en cero', async () => {
  const port = makePort({
    movimientosCaja: async () => ({
      data: null,
      error: { code: '42501', message: 'permission denied for table financial_movements' },
    }),
  })

  const res = await loadCaja(port, BIZ, CAJA)

  assert.equal(res.data, null, 'data debe ser null, no un snapshot en cero')
  assert.ok(res.error, 'debe reportar error')
  assert.equal(res.error?.kind, 'permission')
  // El bug original: esto habría sido 0 y se habría renderizado como $0.
  assert.notEqual(res.data?.ventasHoy, 0)
  assert.equal(res.data?.caja, undefined)
})

test('T1b error genérico (500) → error, sin ceros', async () => {
  const port = makePort({
    movimientosCaja: async () => ({ data: null, error: { status: 500, message: 'internal error' } }),
  })
  const res = await loadCaja(port, BIZ, CAJA)
  assert.equal(res.data, null)
  assert.equal(res.error?.kind, 'unknown')
})

test('T1c si UNA consulta del grupo general falla, el grupo entero queda no disponible', async () => {
  // Devolver las otras dos en cero daría un snapshot que parece válido y no lo es.
  const port = makePort({
    stockBajo: async () => ({ data: null, error: { code: '42501' } }),
  })
  const res = await loadGeneral(port, BIZ, WEEK, MONTH)
  assert.equal(res.data, null)
  assert.ok(res.error)
})

test('T1d el error de un grupo NO contamina al otro', async () => {
  const port = makePort({
    movimientosCaja: async () => ({ data: null, error: { code: '42501' } }),
  })
  const general = await loadGeneral(port, BIZ, WEEK, MONTH)
  const caja    = await loadCaja(port, BIZ, CAJA)

  assert.ok(general.data, 'el grupo general sigue funcionando')
  assert.equal(general.error, null)
  assert.equal(caja.data, null, 'el grupo caja falla')
  assert.ok(caja.error)
})

test('T1e el mensaje de error es apto para UI: sin SQLSTATE ni nombres de tabla', () => {
  const perm = toFinanceLoadError({ code: '42501', message: 'permission denied for table owner_withdrawals' })
  assert.equal(perm.message, FINANCE_PERMISSION_MESSAGE)
  assert.ok(!perm.message.includes('42501'))
  assert.ok(!perm.message.toLowerCase().includes('owner_withdrawals'))
  assert.ok(!perm.message.toLowerCase().includes('permission denied'))

  const unk = toFinanceLoadError(new Error('connect ECONNREFUSED 127.0.0.1:54321'))
  assert.equal(unk.message, FINANCE_UNAVAILABLE_MESSAGE)
  assert.ok(!unk.message.includes('127.0.0.1'))
})

test('T1f el código para el logger se extrae sin filtrar el mensaje crudo', () => {
  assert.equal(financeErrorCode({ code: '42501', message: 'permission denied for table x' }), '42501')
  assert.equal(financeErrorCode({ status: 500 }), 'http_500')
  assert.equal(financeErrorCode(new Error('boom')), 'unknown')
  assert.equal(financeErrorCode(null), 'unknown')
})

test('T1g el código sobrevive a la normalización (el logger no pierde el SQLSTATE)', async () => {
  // El error crudo muere dentro del loader: si el code no viaja en
  // FinanceLoadError, arriba solo queda 'unknown' y el log pierde todo valor.
  const port = makePort({
    movimientosCaja: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
  })
  const res = await loadCaja(port, BIZ, CAJA)
  assert.equal(res.error?.code, '42501')
  assert.equal(res.error?.kind, 'permission')
  // …y el mensaje que ve el usuario sigue siendo el sanitizado.
  assert.equal(res.error?.message, FINANCE_PERMISSION_MESSAGE)

  const port500 = makePort({
    movimientosCaja: async () => ({ data: null, error: { status: 500, message: 'boom' } }),
  })
  const res500 = await loadCaja(port500, BIZ, CAJA)
  assert.equal(res500.error?.code, 'http_500')
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2 — transición caja null → UUID no toca las consultas generales
// ═════════════════════════════════════════════════════════════════════════════

test('T2a sin caja abierta NO se consulta la caja (cero legítimo, no error)', async () => {
  const port = makePort()
  const res = await loadCaja(port, BIZ, null)

  assert.deepEqual(port.calls, [], 'no debe salir ninguna consulta')
  assert.equal(res.error, null)
  assert.equal(res.data?.ventasHoy, 0)
  assert.equal(res.data?.cajaAbierta, false)
  assert.equal(res.data?.caja.net, 0)
})

test('T2b caja null → UUID: solo se consulta la caja, nada del grupo general', async () => {
  const port = makePort()

  // Montaje inicial: general + caja(null)
  await loadGeneral(port, BIZ, WEEK, MONTH)
  await loadCaja(port, BIZ, null)

  const trasMontaje = [...port.calls]
  assert.deepEqual(
    trasMontaje,
    [`ventasDesde:${WEEK}`, `ventasDesde:${MONTH}`, 'stockBajo'],
    'el montaje pide el grupo general y nada de caja',
  )

  // Se resuelve activeCaja: null → UUID. Solo debe correr el grupo de caja.
  port.calls.length = 0
  await loadCaja(port, BIZ, CAJA)

  assert.deepEqual(port.calls, ['movimientosCaja'],
    'al resolverse la caja SOLO se pide la caja')
  assert.ok(!port.calls.some(c => c.startsWith('ventasDesde')),
    'las ventas generales no se vuelven a pedir')
  assert.ok(!port.calls.includes('stockBajo'),
    'el stock bajo no se vuelve a pedir')
})

test('T2c cambio entre dos cajas: tampoco toca el grupo general', async () => {
  const port = makePort()
  await loadCaja(port, BIZ, CAJA)
  port.calls.length = 0
  await loadCaja(port, BIZ, '00000000-0000-0000-0000-00000000fc02')
  assert.deepEqual(port.calls, ['movimientosCaja'])
})

test('T2d el grupo general nunca consulta movimientos de caja', async () => {
  const port = makePort()
  await loadGeneral(port, BIZ, WEEK, MONTH)
  assert.ok(!port.calls.includes('movimientosCaja'),
    'loadGeneral no debe depender de la caja bajo ninguna circunstancia')
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3 — respuesta válida con valores reales
// ═════════════════════════════════════════════════════════════════════════════

test('T3a valores reales se calculan y no aparece error', async () => {
  const port = makePort({
    movimientosCaja: async () => ({
      data: [
        { type: 'income',  amount_ars: 15000,   metodo_pago: 'efectivo' },
        { type: 'income',  amount_ars: 4562420, metodo_pago: 'transferencia' },
        { type: 'expense', amount_ars: 2420,    metodo_pago: 'efectivo' },
      ] as MovimientoCajaRow[],
      error: null,
    }),
  })

  const res = await loadCaja(port, BIZ, CAJA)

  assert.equal(res.error, null)
  assert.equal(res.data?.ventasHoy, 4577420)
  assert.equal(res.data?.caja.income, 4577420)
  assert.equal(res.data?.caja.expense, 2420)
  assert.equal(res.data?.caja.net, 4575000)
  assert.equal(res.data?.cajaAbierta, true)
})

test('T3b el desglose por método ordena por monto y calcula el porcentaje', () => {
  const { paymentMethods, ventasHoy } = aggregateCaja([
    { type: 'income', amount_ars: 2500, metodo_pago: 'efectivo' },
    { type: 'income', amount_ars: 7500, metodo_pago: 'transferencia' },
  ])
  assert.equal(ventasHoy, 10000)
  assert.equal(paymentMethods[0].method, 'transferencia')
  assert.equal(paymentMethods[0].pct, 75)
  assert.equal(paymentMethods[1].pct, 25)
})

test('T3c grupo general con valores reales', async () => {
  const port = makePort()
  const res = await loadGeneral(port, BIZ, WEEK, MONTH)
  assert.equal(res.error, null)
  assert.equal(res.data?.ventasSemana, 1500)
  assert.equal(res.data?.ventasMes, 1500)
  assert.equal(res.data?.stockBajoCount, 3)
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST 4 — un cero REAL sigue siendo cero (no se confunde con error)
// ═════════════════════════════════════════════════════════════════════════════

test('T4a caja abierta sin movimientos → ceros reales, sin error', async () => {
  const port = makePort({
    movimientosCaja: async () => ({ data: [], error: null }),
  })
  const res = await loadCaja(port, BIZ, CAJA)

  assert.equal(res.error, null, 'una respuesta vacía NO es un error')
  assert.ok(res.data, 'debe haber snapshot')
  assert.equal(res.data?.ventasHoy, 0)
  assert.equal(res.data?.caja.net, 0)
  assert.equal(res.data?.cajaAbierta, true, 'la caja está abierta aunque no tenga movimientos')
})

test('T4b grupo general en cero real → cero, sin error', async () => {
  const port = makePort({
    ventasDesde: async () => ({ data: [], error: null }),
    stockBajo:   async () => ({ data: 0,  error: null }),
  })
  const res = await loadGeneral(port, BIZ, WEEK, MONTH)
  assert.equal(res.error, null)
  assert.equal(res.data?.ventasSemana, 0)
  assert.equal(res.data?.stockBajoCount, 0)
})

test('T4c cero real y error son distinguibles por el consumidor', async () => {
  const ok = await loadCaja(makePort({ movimientosCaja: async () => ({ data: [], error: null }) }), BIZ, CAJA)
  const ko = await loadCaja(makePort({ movimientosCaja: async () => ({ data: null, error: { code: '42501' } }) }), BIZ, CAJA)

  // Este es el corazón del lote: cero y fallo NO pueden verse igual.
  assert.equal(ok.data?.ventasHoy, 0)
  assert.equal(ok.error, null)
  assert.equal(ko.data, null)
  assert.ok(ko.error)
  assert.notDeepEqual(ok, ko)
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5 — sumas y bordes
// ═════════════════════════════════════════════════════════════════════════════

test('T5a sumVentas tolera amount_ars null sin romper ni inventar', () => {
  assert.equal(sumVentas([{ amount_ars: 100 }, { amount_ars: null }, { amount_ars: 50 }]), 150)
  assert.equal(sumVentas([]), 0)
})

test('T5b montos negativos se toman por su valor absoluto según el tipo', () => {
  const { caja } = aggregateCaja([
    { type: 'expense', amount_ars: -3000, metodo_pago: 'efectivo' },
    { type: 'income',  amount_ars: 1000,  metodo_pago: 'efectivo' },
  ])
  assert.equal(caja.expense, 3000)
  assert.equal(caja.income, 1000)
  assert.equal(caja.net, -2000)
})

test('T5c metodo_pago null cae en "otro" sin perder el monto', () => {
  const { caja } = aggregateCaja([{ type: 'income', amount_ars: 800, metodo_pago: null }])
  assert.equal(caja.income, 800)
  assert.equal(caja.byMethod[0].method, 'otro')
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST 6 — el hook mantiene el contrato (StrictMode y separación de effects)
// ═════════════════════════════════════════════════════════════════════════════
// El hook importa supabase (import.meta.env) y no corre en Node; acá se fija el
// contrato estructural que los tests de comportamiento no pueden alcanzar.
// No se asume una cantidad absoluta de montajes en desarrollo.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf-8')

test('T6a StrictMode sigue activo en main.tsx', () => {
  const s = read('src/main.tsx')
  assert.ok(/<React\.StrictMode>/.test(s), 'StrictMode no debe eliminarse para esconder el doble montaje')
})

test('T6b el hook ya no consulta v_finance_position (consulta muerta eliminada)', () => {
  const s = read('src/hooks/useFinancialDashboard.ts')
  assert.ok(!/v_finance_position/.test(s),
    'la vista alimentaba campos que ningún componente renderiza desde 3f9f904')
  assert.ok(!/ccClientesDeuda|ccProveedoresDeuda/.test(s))
})

test('T6c los dos grupos tienen effects y deps separadas', () => {
  const s = read('src/hooks/useFinancialDashboard.ts')
  // El grupo general NO puede depender de cajaKey: ese era el acoplamiento.
  const general = s.match(/const runGeneral = useCallback\([\s\S]*?\}, \[([^\]]*)\]\)/)
  assert.ok(general, 'runGeneral debe existir')
  assert.ok(!/cajaKey/.test(general![1]), `runGeneral no debe depender de cajaKey (deps: ${general![1]})`)

  const caja = s.match(/const runCaja = useCallback\([\s\S]*?\}, \[([^\]]*)\]\)/)
  assert.ok(caja, 'runCaja debe existir')
  assert.ok(/cajaKey/.test(caja![1]), 'runCaja SÍ debe depender de cajaKey')
})

test('T6d las respuestas obsoletas se descartan con contador de request', () => {
  const s = read('src/hooks/useFinancialDashboard.ts')
  assert.ok(/generalReq/.test(s) && /cajaReq/.test(s), 'debe haber guardas por grupo')
  assert.ok(/req !== generalReq\.current/.test(s), 'la carga general descarta respuestas viejas')
  assert.ok(/req !== cajaReq\.current/.test(s), 'la carga de caja descarta respuestas viejas')
})

test('T6e el Dashboard muestra "No disponible" en vez de $0 cuando la caja falla', () => {
  const s = read('src/pages/Dashboard.tsx')
  assert.ok(/finCajaError/.test(s), 'el Dashboard debe consumir el error de caja')
  assert.ok(/No disponible/.test(s), 'debe existir el estado visible de dato no disponible')
  // No debe quedar el fallback ciego a cero en las tarjetas de caja.
  assert.ok(!/finData\.caja\.income - finData\.caja\.expense/.test(s),
    'el cálculo inline con fallback a 0 se reemplazó por caja.net y el guard de error')
})
