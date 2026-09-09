// ─────────────────────────────────────────────────────────────────────────────
// TASKS-V2-1 — agrupación temporal.
//
// Lógica pura: se le pasa el "hoy" explícitamente, así que los tests no dependen
// del reloj ni de la zona horaria de la máquina que los corre.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import {
  groupTasksByTime, groupKeyFor, isActiveTask, isOverdueTask, isDueTodayTask,
  countActive, TASK_GROUP_ORDER,
} from '../../src/components/tasks/taskGrouping'

const TODAY = '2026-09-09'

const t = (over: Record<string, unknown> = {}) => ({
  status: 'pending', due_date: null, priority: 'medium',
  created_at: '2026-09-01T10:00:00Z', completed_at: null, title: 'x', ...over,
}) as Parameters<typeof groupKeyFor>[0]

describe('clasificación de una tarea', () => {
  it('vencida: la fecha ya pasó y sigue activa', () => {
    expect(groupKeyFor(t({ due_date: '2026-09-08' }), TODAY)).toBe('overdue')
    expect(isOverdueTask(t({ due_date: '2026-09-08' }), TODAY)).toBe(true)
  })

  it('hoy: vence exactamente hoy', () => {
    expect(groupKeyFor(t({ due_date: TODAY }), TODAY)).toBe('today')
    expect(isDueTodayTask(t({ due_date: TODAY }), TODAY)).toBe(true)
    // Vencer hoy NO es estar vencida.
    expect(isOverdueTask(t({ due_date: TODAY }), TODAY)).toBe(false)
  })

  it('próxima: vence después de hoy', () => {
    expect(groupKeyFor(t({ due_date: '2026-09-10' }), TODAY)).toBe('upcoming')
  })

  it('sin fecha: activa y sin vencimiento', () => {
    expect(groupKeyFor(t({ due_date: null }), TODAY)).toBe('no_date')
  })

  it('completada: sale de los grupos activos aunque su fecha haya pasado', () => {
    const done = t({ status: 'completed', due_date: '2026-01-01' })
    expect(groupKeyFor(done, TODAY)).toBe('completed')
    expect(isOverdueTask(done, TODAY)).toBe(false)
    expect(isActiveTask(done)).toBe(false)
  })

  it('una fila histórica cancelada se trata como cerrada, no como vencida para siempre', () => {
    const cancelled = t({ status: 'cancelled', due_date: '2026-01-01' })
    expect(groupKeyFor(cancelled, TODAY)).toBe('completed')
    expect(isOverdueTask(cancelled, TODAY)).toBe(false)
  })

  it('compara fechas como strings ISO, sin construir Date a partir de due_date', () => {
    // El patrón viejo `new Date(due_date + 'T23:59:59')` interpretaba la fecha en
    // la zona del navegador: el día de ayer podía caer en «hoy» y viceversa.
    // Acá el límite es exacto en ambos lados.
    expect(groupKeyFor(t({ due_date: '2026-09-08' }), TODAY)).toBe('overdue')
    expect(groupKeyFor(t({ due_date: '2026-09-09' }), TODAY)).toBe('today')
    expect(groupKeyFor(t({ due_date: '2026-09-10' }), TODAY)).toBe('upcoming')
  })
})

describe('groupTasksByTime', () => {
  const tasks = [
    t({ due_date: '2026-09-10', title: 'proxima' }),
    t({ due_date: '2026-09-07', title: 'vencida-vieja' }),
    t({ due_date: null, title: 'sin-fecha' }),
    t({ due_date: TODAY, title: 'hoy' }),
    t({ due_date: '2026-09-08', title: 'vencida-nueva' }),
    t({ status: 'completed', completed_at: '2026-09-09T09:00:00Z', title: 'hecha' }),
  ]

  it('reparte cada tarea en un único grupo', () => {
    const g = groupTasksByTime(tasks, TODAY)
    expect(g.overdue.map(x => x.title)).toEqual(['vencida-vieja', 'vencida-nueva'])
    expect(g.today.map(x => x.title)).toEqual(['hoy'])
    expect(g.upcoming.map(x => x.title)).toEqual(['proxima'])
    expect(g.no_date.map(x => x.title)).toEqual(['sin-fecha'])
    expect(g.completed.map(x => x.title)).toEqual(['hecha'])
  })

  it('separa lo completado de lo activo', () => {
    const g = groupTasksByTime(tasks, TODAY)
    expect(countActive(g)).toBe(5)
    for (const key of TASK_GROUP_ORDER) {
      expect(g[key].every(x => x.status !== 'completed')).toBe(true)
    }
  })

  it('ordena las vencidas de la más atrasada a la menos', () => {
    const g = groupTasksByTime(tasks, TODAY)
    expect(g.overdue.map(x => x.due_date)).toEqual(['2026-09-07', '2026-09-08'])
  })

  it('ordena las próximas por la que vence antes', () => {
    const g = groupTasksByTime([
      t({ due_date: '2026-09-20', title: 'lejana' }),
      t({ due_date: '2026-09-11', title: 'cercana' }),
    ], TODAY)
    expect(g.upcoming.map(x => x.title)).toEqual(['cercana', 'lejana'])
  })

  it('dentro de Hoy manda la prioridad, porque la fecha ya no distingue', () => {
    const g = groupTasksByTime([
      t({ due_date: TODAY, priority: 'low', title: 'baja' }),
      t({ due_date: TODAY, priority: 'high', title: 'alta' }),
      t({ due_date: TODAY, priority: 'medium', title: 'normal' }),
    ], TODAY)
    expect(g.today.map(x => x.title)).toEqual(['alta', 'normal', 'baja'])
  })

  it('trata urgent como la prioridad más alta al ordenar filas históricas', () => {
    const g = groupTasksByTime([
      t({ due_date: TODAY, priority: 'high', title: 'alta' }),
      t({ due_date: TODAY, priority: 'urgent', title: 'historica' }),
    ], TODAY)
    expect(g.today.map(x => x.title)).toEqual(['historica', 'alta'])
  })

  it('muestra primero lo último completado', () => {
    const g = groupTasksByTime([
      t({ status: 'completed', completed_at: '2026-09-01T10:00:00Z', title: 'vieja' }),
      t({ status: 'completed', completed_at: '2026-09-09T10:00:00Z', title: 'reciente' }),
    ], TODAY)
    expect(g.completed.map(x => x.title)).toEqual(['reciente', 'vieja'])
  })

  it('no muta el array recibido ni las tareas', () => {
    const input = [t({ due_date: '2026-09-10', title: 'a' }), t({ due_date: '2026-09-07', title: 'b' })]
    const snapshot = JSON.parse(JSON.stringify(input))
    groupTasksByTime(input, TODAY)
    expect(input).toEqual(snapshot)
  })

  it('devuelve los cinco grupos aunque no haya tareas', () => {
    const g = groupTasksByTime([], TODAY)
    expect(Object.keys(g).sort()).toEqual(['completed', 'no_date', 'overdue', 'today', 'upcoming'])
    expect(countActive(g)).toBe(0)
  })
})
