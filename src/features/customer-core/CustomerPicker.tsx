import { useEffect, useRef, useState } from 'react'
import { Check, UserPlus } from 'lucide-react'
import { AppButton, AppInput } from '../../ui'
import {
  searchPosCustomers,
  type PosCustomerOption,
} from '../../services/posCustomerSearchService'

/**
 * ORDERS-V2-0 — selector de cliente reutilizable.
 *
 * Antes cada pantalla resolvía esto por su cuenta. Nueva Orden llamaba a
 * `customersService.getAll()` y filtraba en memoria: un taller con 4.000
 * clientes se traía las 4.000 filas al browser en cada alta.
 *
 * La búsqueda NO se reimplementa acá: la resuelve `searchPosCustomers`, que ya
 * es la autoridad del POS — filtra server-side por nombre, teléfono y
 * documento (tolerando `DNI: 30.123.456` y `20-30123456-7`), acota a 25
 * resultados y los rankea. Este componente sólo aporta presentación,
 * debounce y cancelación.
 */

export type CustomerPickerOption = PosCustomerOption

/** Debajo de esto el usuario todavía está tipeando, no buscando. */
const SEARCH_DEBOUNCE_MS = 250

export interface CustomerPickerProps {
  businessId: string | null | undefined
  /** Id del cliente elegido, para pintar el estado seleccionado. */
  selectedId: string
  onSelect: (customer: CustomerPickerOption) => void
  /** Si se omite, no se ofrece el alta desde el selector. */
  onCreateNew?: () => void
  label?: string
  /** Se antepone a los resultados del servidor (p. ej. un alta recién hecha). */
  pinned?: CustomerPickerOption[]
}

export function CustomerPicker({
  businessId,
  selectedId,
  onSelect,
  onCreateNew,
  label = 'Buscar cliente',
  pinned = [],
}: CustomerPickerProps) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CustomerPickerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setLoading(true)

    const timer = setTimeout(() => {
      searchPosCustomers({
        businessId,
        query,
        signal: controller.signal,
        // Al abrir, sin escribir nada, los últimos clientes cargados son
        // mejores candidatos que los primeros alfabéticamente.
        orderBy: 'recent',
      })
        .then(result => {
          if (controller.signal.aborted) return
          setItems(result.status === 'ok' ? result.items : [])
          setTruncated(result.truncated)
          setError(result.status === 'error' ? 'No se pudieron buscar clientes. Reintentá.' : '')
        })
        .catch(() => {
          // Abortar una búsqueda vieja no es un error que mostrarle a nadie.
          if (!controller.signal.aborted) setError('No se pudieron buscar clientes. Reintentá.')
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, SEARCH_DEBOUNCE_MS)

    return () => { clearTimeout(timer); controller.abort() }
  }, [businessId, query])

  // Un cliente recién creado todavía no necesariamente vuelve del servidor
  // (índice, replicación, o simplemente que no matchea la búsqueda vigente).
  // Va primero y sin duplicarse.
  const pinnedIds = new Set(pinned.map(customer => customer.id))
  const visible = [...pinned, ...items.filter(customer => !pinnedIds.has(customer.id))]

  const trimmed = query.trim()
  const tooShort = trimmed.length === 1

  return (
    <>
      <AppInput
        semantic="search"
        label={label}
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Nombre, teléfono, DNI/CUIT o empresa"
        data-testid="customer-picker-search"
      />

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="intake-customer-list" data-testid="customer-picker-results">
        {visible.map(customer => (
          <button
            type="button"
            key={customer.id}
            className={selectedId === customer.id ? 'is-selected' : ''}
            aria-pressed={selectedId === customer.id}
            onClick={() => onSelect(customer)}
          >
            <span>{customer.name}</span>
            <small>{[customer.phone, customer.document].filter(Boolean).join(' · ') || 'Sin contacto'}</small>
            {selectedId === customer.id && <Check size={18} />}
          </button>
        ))}
      </div>

      {/* Estados excluyentes: nunca «no hay resultados» mientras se busca. */}
      {loading && !visible.length && <p className="form-hint" role="status">Buscando…</p>}
      {!loading && tooShort && <p className="form-hint">Escribí al menos 2 caracteres.</p>}
      {!loading && !tooShort && !visible.length && !error && (
        <p className="form-hint">
          {trimmed ? 'No encontramos coincidencias.' : 'Todavía no hay clientes cargados.'}
        </p>
      )}
      {truncated && !loading && (
        <p className="form-hint">Hay más resultados. Afiná la búsqueda para verlos.</p>
      )}

      {onCreateNew && (
        <AppButton variant="secondary" fullWidth leftIcon={<UserPlus size={18} />} onClick={onCreateNew}>
          Crear cliente rápido
        </AppButton>
      )}
    </>
  )
}
