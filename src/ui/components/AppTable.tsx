// ─── AppTable ─────────────────────────────────────────────────────────────────
// Wrapper estándar para tablas — aplica el sistema CSS del design system.

export interface TableColumn<T = any> {
  key: string
  label: string
  align?: 'left' | 'right' | 'center'
  width?: string
  render?: (row: T, index: number) => React.ReactNode
}

interface AppTableProps<T = any> {
  columns: TableColumn<T>[]
  rows: T[]
  keyExtractor: (row: T, index: number) => string
  compact?: boolean
  /** Contenido del empty state si rows.length === 0 */
  emptyState?: React.ReactNode
  /** Spinner de loading */
  loading?: boolean
  /** Si true, las filas pueden hacer click */
  onRowClick?: (row: T) => void
  className?: string
}

export function AppTable<T>({
  columns, rows, keyExtractor, compact, emptyState, loading,
  onRowClick, className = '',
}: AppTableProps<T>) {
  const tableClass = `table ${compact ? 'table-sm' : ''} ${className}`

  return (
    <div className="card table-wrap" style={{ padding: 0 }}>
      <table className={tableClass}>
        <thead>
          <tr>
            {columns.map(col => (
              <th
                key={col.key}
                style={{
                  textAlign: col.align ?? 'left',
                  width: col.width,
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={columns.length} style={{ padding: 0, border: 'none' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="skeleton" style={{ height: 40 }} />
                  ))}
                </div>
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{ border: 'none', padding: 0 }}
              >
                {emptyState ?? (
                  <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.875rem' }}>
                    No hay datos para mostrar.
                  </div>
                )}
              </td>
            </tr>
          )}
          {!loading && rows.map((row, idx) => (
            <tr
              key={keyExtractor(row, idx)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns.map(col => (
                <td
                  key={col.key}
                  style={{ textAlign: col.align ?? 'left' }}
                >
                  {col.render ? col.render(row, idx) : (row as any)[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Actions cell helper ──────────────────────────────────────────────────────
// Para la última columna de acciones en tablas

export function TableActions({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'flex-end' }}>
      {children}
    </div>
  )
}
