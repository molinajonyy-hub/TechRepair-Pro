// ─── Zona horaria del negocio ─────────────────────────────────────────────────
// Todas las fechas se guardan en UTC en la DB. Este módulo centraliza la
// conversión a hora local de Córdoba, Argentina (UTC-3, sin horario de verano).

export const TZ_AR = 'America/Argentina/Cordoba'

// ─── Parser interno ───────────────────────────────────────────────────────────
// Strings de solo fecha (YYYY-MM-DD) se interpretan como medianoche Argentina
// para evitar que UTC-midnight aparezca como el día anterior en UTC-3.

function parse(d: string): Date {
  if (!d) return new Date(0)
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + 'T00:00:00-03:00')
  return new Date(d)
}

// ─── Formatters de fecha ──────────────────────────────────────────────────────

/** "15 may '24" — formato estándar para listas y tablas */
export const fmtDate = (d: string): string =>
  parse(d).toLocaleDateString('es-AR', {
    timeZone: TZ_AR, day: '2-digit', month: 'short', year: '2-digit',
  })

/** "15 may" — sin año, para vistas compactas */
export const fmtDateCompact = (d: string): string =>
  parse(d).toLocaleDateString('es-AR', {
    timeZone: TZ_AR, day: '2-digit', month: 'short',
  })

/** "15 may 2024" — año completo, para Finance y reportes */
export const fmtDateFull = (d: string): string =>
  parse(d).toLocaleDateString('es-AR', {
    timeZone: TZ_AR, day: '2-digit', month: 'short', year: 'numeric',
  })

/** "lun 15 may '24" — con día de semana, para historial de caja */
export const fmtDateShort = (d: string): string =>
  new Date(d).toLocaleDateString('es-AR', {
    timeZone: TZ_AR, weekday: 'short', day: '2-digit', month: 'short', year: '2-digit',
  })

// ─── Formatters de hora ───────────────────────────────────────────────────────

/** "14:30" */
export const fmtTime = (d: string): string =>
  new Date(d).toLocaleTimeString('es-AR', {
    timeZone: TZ_AR, hour: '2-digit', minute: '2-digit',
  })

// ─── Formatters de fecha + hora ───────────────────────────────────────────────

/** "lun 15 may 14:30" — para headers de caja y notificaciones */
export const fmtDateTime = (d: string): string =>
  new Date(d).toLocaleString('es-AR', {
    timeZone: TZ_AR, weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })

/** Alias de fmtDateTime — compatibilidad con CajaPage */
export const fmtDateLong = fmtDateTime

/** "15 may 14:30" — sin día de semana, para Tasks y timelines */
export const fmtFull = (d: string): string =>
  new Date(d).toLocaleString('es-AR', {
    timeZone: TZ_AR, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })

/** "lun 15 may 2024 14:30" — para comprobantes y prints */
export const fmtDateTimeFull = (d: string): string =>
  new Date(d).toLocaleString('es-AR', {
    timeZone: TZ_AR, weekday: 'short', day: '2-digit', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

// ─── Comparaciones de día ─────────────────────────────────────────────────────

/** Compara si un datetime UTC cae en el día de hoy en Argentina */
export const isToday = (d: string): boolean => {
  const opts: Intl.DateTimeFormatOptions = { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit' }
  return new Date(d).toLocaleDateString('es-AR', opts) ===
         new Date().toLocaleDateString('es-AR', opts)
}

/** Devuelve "YYYY-MM-DD" del día actual en Argentina (para queries de DB) */
export const todayAR = (): string => {
  const s = new Date().toLocaleDateString('es-AR', {
    timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  // es-AR: "dd/mm/aaaa"
  const [day, month, year] = s.split('/')
  return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`
}
