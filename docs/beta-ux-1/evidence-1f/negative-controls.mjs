// BETA-UX-1F — controles negativos.
//
// Un test verde no prueba nada si nunca puede ponerse en rojo. Este runner rompe
// A PROPÓSITO cada invariante del lote, corre la suite y exige que falle —y que
// falle en el test que corresponde—. Después restaura el archivo y comprueba,
// byte a byte, que quedó igual que antes. No queda ningún mutante.
//
// Uso: node negative-controls-1f.mjs <worktree> [filtro]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

const root = process.argv[2]
const filtro = process.argv[3] || ''
const SUITE = 'tests/components/betaUx1fDashboard.test.tsx'
const hash = s => crypto.createHash('sha256').update(s).digest('hex')
const diffAntes = hash(execFileSync('git', ['-C', root, 'diff'], { encoding: 'utf8', maxBuffer: 64e6 }))

const DASH = 'src/pages/Dashboard.tsx'
const ANCLA_JSX = '      <FirstStepsChecklist />\n'
const tras = (ancla, extra) => s => { if (!s.includes(ancla)) throw new Error('ancla ausente'); return s.replace(ancla, () => ancla + extra) }
const cambiar = (a, b) => s => { if (!s.includes(a)) throw new Error(`texto ausente: ${a.slice(0, 70)}`); return s.replace(a, () => b) }

/** [nombre, archivo, mutación, fragmento que debe aparecer entre los tests fallidos] */
const CONTROLES = [
  ['01 reintroducir «Ganancia Real Hoy»', DASH,
    tras(ANCLA_JSX, '      <div className="stat-card" data-testid="dash-ganancia-real"><div className="stat-card-label">Ganancia Real Hoy</div></div>\n'),
    'no existen las tarjetas financieras'],
  ['02 reintroducir useFinancialDashboard en Inicio', DASH,
    s => cambiar("import { usePermissions } from '../hooks/usePermissions'\n",
      "import { usePermissions } from '../hooks/usePermissions'\nimport { useFinancialDashboard } from '../hooks/useFinancialDashboard'\n")(
      cambiar('  const [tasksRefreshKey, setTasksRefreshKey] = useState(0)\n',
        "  const [tasksRefreshKey, setTasksRefreshKey] = useState(0)\n  useFinancialDashboard('22222222-2222-4222-8222-222222222222', 'caja-1')\n")(s)),
    'ningún montaje de Inicio ni de la barra superior pidió una fuente financiera'],
  ['03 volver a mostrar los accesos rápidos', DASH,
    tras(ANCLA_JSX, '      <section data-testid="dashboard-quick-actions"><h2>Accesos rápidos</h2><button>Nuevo Cliente</button></section>\n'),
    'no existen los accesos rápidos'],
  ['04 volver a mostrar «Movimientos Caja»', DASH,
    tras(ANCLA_JSX, '      <div role="tablist"><button role="tab">Movimientos Caja</button></div>\n'),
    'no existen las pestañas'],
  ['05 mostrar «Registrar gasto» sin finance', DASH,
    cambiar("const puedeRegistrarGasto = can('finance')", 'const puedeRegistrarGasto = true'),
    'sales null ve'],
  ['06 quitar Tareas de Inicio', DASH,
    cambiar('      <DashboardTasks refreshKey={tasksRefreshKey} />\n', ''),
    '«Mis tareas» está en Inicio'],
  ['07a romper dueToday (fecha UTC en vez de la argentina)', 'src/services/taskService.ts',
    cambiar('    const today = todayAR()\n', '    const today = new Date().toISOString().slice(0, 10)\n'),
    'con la fecha de negocio argentina'],
  ['07b romper dueToday (contar también las completadas)', 'src/services/taskService.ts',
    cambiar("    t.status !== 'completed' &&\n    t.status !== 'cancelled' &&\n    t.due_date.slice(0, 10) === today", '    t.due_date.slice(0, 10) === today'),
    'compara el día de calendario'],
  ['08a devolver la caja a una franja en el cuerpo de Inicio', DASH,
    tras(ANCLA_JSX, '      <div data-testid="dash-estado-caja" style={{ display: \'flex\', width: \'100%\' }}>Caja abierta · Gestionar →</div>\n'),
    'no existe la franja de caja'],
  ['08b convertir el chip de caja en una franja de ancho completo', 'src/index.css',
    cambiar('.shell-chip {\n  position: relative;\n  isolation: isolate;\n  display: inline-flex;', '.shell-chip {\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  width: 100%;'),
    'la caja en la barra es un chip'],
  ['09a las filas de órdenes recientes dejan de ser clickeables', DASH,
    cambiar('                    onClick={event => openFromRow(event, order.id)}\n', ''),
    'la fila entera abre la orden'],
  ['09b las tarjetas mobile dejan de abrir la orden', DASH,
    cambiar('    onSelect: () => open(order.id),\n', ''),
    'tocar la tarjeta abre el detalle'],
  ['10 reintroducir un importe financiero en Inicio', DASH,
    tras(ANCLA_JSX, '      <p>Cobrado hoy: $125.000</p>\n'),
    'ningún importe, ningún símbolo de moneda'],
  // ── Extras: autoridad de caja, red y estados canónicos ────────────────────
  ['11 el vendedor puede gestionar la caja desde el chip', 'src/components/layout/CajaStatusChip.tsx',
    cambiar('  if (canUseCaja) {', '  if (canSeeCajaStatus) {'),
    'conoce el estado y NO puede gestionar'],
  ['12 el chip de caja se muestra a quien no necesita conocerla', 'src/components/layout/CajaStatusChip.tsx',
    cambiar('  if (!canSeeCajaStatus || loading) return null', '  if (loading) return null'),
    'no ve el chip de caja'],
  ['13 el hook operacional vuelve a leer finanzas', 'src/hooks/useOperationalDashboardStats.ts',
    cambiar('  const rows = (recent.data ?? []) as unknown as RecentOrderRow[]\n',
      "  await supabase.from('business_finance_entries').select('type, amount_ars').eq('business_id', businessId)\n  const rows = (recent.data ?? []) as unknown as RecentOrderRow[]\n"),
    'sólo órdenes, tareas, primeros pasos y el estado de la caja'],
  ['14 «Listas para entregar» con el alias legacy `ready`', 'src/hooks/useOperationalDashboardStats.ts',
    cambiar("const READY_DELIVERY: OrderStatus = 'ready_delivery'", "const READY_DELIVERY = 'ready' as OrderStatus"),
    'activas = total − completadas − canceladas'],
  ['15 «nuevas hoy» cortado en la medianoche UTC', 'src/hooks/useOperationalDashboardStats.ts',
    cambiar('businessDayStartInstant(businessToday())', "new Date().toISOString().split('T')[0]"),
    'cuenta desde las 00:00 de Argentina'],
  ['16 el reprecio de inventario vuelve a depender de Inicio', DASH,
    s => cambiar("import { refreshSharedDollarRate } from '../hooks/useDollarRate'\n",
      "import { refreshSharedDollarRate } from '../hooks/useDollarRate'\nimport { refreshInventoryDollarPrices } from '../services/dollarRateService'\n")(
      cambiar('    void refreshSharedDollarRate()\n', "    void refreshSharedDollarRate()\n    void refreshInventoryDollarPrices('x')\n")(s)),
    'ninguna página lo dispara'],
  ['17 dos lecturas de la cotización (cada chip pide la suya)', 'src/hooks/useDollarRate.ts',
    s => cambiar('  if (inFlight && inFlight.businessId === businessId) return inFlight.promise\n', '')(
      cambiar('  if (snapshot.businessId !== businessId) {\n    // Otro negocio', '  if (snapshot.businessId !== businessId || consumers > 1) {\n    // Otro negocio')(s)),
    'comparten la misma lectura'],
  ['18 «Registrar gasto» pierde la variante danger', DASH,
    cambiar('                variant="danger"\n', '                variant="ghost"\n'),
    'usa la variante `danger`'],
  ['19 Tareas queda debajo de las órdenes recientes', DASH,
    s => cambiar('      <DashboardTasks refreshKey={tasksRefreshKey} />\n', '')(s)
      .replace(/(\{!error && <RecentOrders [^\n]*\n)/, (m) => m + '      <DashboardTasks refreshKey={tasksRefreshKey} />\n'),
    'después de «Hoy» y antes de las órdenes recientes'],
  ['20 la bienvenida duplicada vuelve junto a Primeros pasos', DASH,
    tras(ANCLA_JSX, '      <div className="card"><p>¡Bienvenido a TechRepair Pro!</p><button>Crear primera orden</button></div>\n'),
    'sin la bienvenida duplicada'],
]

const vitest = () => spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', SUITE],
  { cwd: root, encoding: 'utf8', maxBuffer: 64e6 })

let fallas = 0
const lineas = []
for (const [nombre, archivo, mutar, esperado] of CONTROLES) {
  if (filtro && !nombre.includes(filtro)) continue
  const ruta = path.join(root, archivo)
  const original = fs.readFileSync(ruta, 'utf8')
  let resultado
  try {
    const mutado = mutar(original)
    if (mutado === original) throw new Error('la mutación no cambió el archivo')
    if (mutado.includes('\r\n')) throw new Error('la mutación introdujo CRLF')
    fs.writeFileSync(ruta, mutado, 'utf8')
    const r = vitest()
    const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const fallidos = [...salida.matchAll(/^\s*(?:×|FAIL)\s+(.*)$/gm)].map(m => m[1].trim())
    const resumen = /Tests\s+(\d+) failed/.exec(salida)?.[1] ?? '0'
    const acerto = fallidos.some(f => f.includes(esperado))
    resultado = r.status !== 0 && acerto
      ? `OK    ${nombre} → rojo (${resumen} tests), incluido «${esperado}»`
      : `FALLA ${nombre} → exit=${r.status}, ${resumen} tests rojos; no apareció «${esperado}»\n        ${fallidos.slice(0, 4).join('\n        ')}`
    if (!(r.status !== 0 && acerto)) fallas += 1
  } catch (e) {
    resultado = `FALLA ${nombre} → ${e.message}`
    fallas += 1
  } finally {
    fs.writeFileSync(ruta, original, 'utf8')
    if (fs.readFileSync(ruta, 'utf8') !== original) { console.error(`NO SE PUDO RESTAURAR ${archivo}`); process.exit(3) }
  }
  console.log(resultado)
  lineas.push(resultado)
}

const diffDespues = hash(execFileSync('git', ['-C', root, 'diff'], { encoding: 'utf8', maxBuffer: 64e6 }))
const limpio = diffAntes === diffDespues
console.log(`\nárbol idéntico al de antes de mutar: ${limpio ? 'sí' : 'NO'}`)
console.log(fallas === 0 ? `CONTROLES NEGATIVOS: ${lineas.length}/${lineas.length} detectados` : `CONTROLES NEGATIVOS: ${fallas} mutación(es) NO detectadas`)
process.exit(fallas === 0 && limpio ? 0 : 1)
