import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { normalizeText } from '../../utils/searchUtils'
import {
  computeAnchoredPosition,
  readViewport,
  type AnchoredPosition,
} from './anchoredPosition'

/**
 * ORDERS-V2-0.1 — combobox editable: sugerencias + texto libre.
 *
 * ROOT CAUSE que lo motiva: el intake resolvía marca y modelo con
 * `<input list>` + `<datalist>`. En escritorio Chrome funciona; en WebKit
 * móvil la lista de sugerencias no se despliega de forma confiable, así que
 * en el celular el usuario veía un campo de texto pelado — que es exactamente
 * lo que reportó el owner.
 *
 * `<datalist>` no tiene API para abrirlo, ni estados de carga o vacío, ni
 * forma de estilarlo: la UI la dibuja el navegador. Una función central del
 * producto no puede depender de eso.
 *
 * Este componente implementa el patrón combobox de WAI-ARIA con marcado
 * propio, así que se comporta igual en todos los navegadores.
 *
 * INVARIANTE: **el texto libre siempre gana**. La lista sugiere; nunca
 * restringe. Escribir un modelo que no está en el catálogo tiene que seguir
 * siendo posible, porque el taller recibe equipos que el catálogo no conoce.
 *
 * ── ORDERS-V2-0.1.1 · la lista va en un portal ────────────────────────────
 * El human smoke en iPhone la encontró CORTADA. Medido a 390×844:
 *
 *     lista              top 341 → bottom 597  (alto 256)
 *     .intake-step-card  overflow hidden/hidden, bottom 449
 *
 * La recortaba el `overflow:hidden` de la card del paso, no el viewport: había
 * 327 px libres debajo del campo y la lista no se salía de pantalla. De ahí que
 * subir `z-index` no sirviera —no se escapa de un clip de `overflow`— y que
 * agrandar el alto lo empeorara.
 *
 * Ahora se renderiza con `createPortal` en `document.body` y se posiciona
 * contra el viewport (ver `anchoredPosition.ts`), lo que la saca de CUALQUIER
 * ancestro que recorte y, de paso, resuelve el caso real de falta de espacio:
 * si abajo no entra, se abre hacia arriba.
 *
 * Consecuencia que hay que respetar: la lista deja de ser descendiente del
 * `rootRef`, así que la detección de «click afuera» tiene que contemplarla
 * explícitamente o un tap sobre una opción se leería como click afuera y
 * cerraría el desplegable antes de elegir.
 */

export interface AppComboboxProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
  loading?: boolean
  required?: boolean
  disabled?: boolean
  placeholder?: string
  /** Texto cuando no hay ninguna sugerencia; el campo sigue aceptando texto. */
  emptyHint?: string
  error?: string
  hint?: string
  id?: string
  autoCapitalize?: string
  'data-testid'?: string
}

/** Techo del desplegable: más que esto no se lee, se scrollea a ciegas. */
const MAX_VISIBLE = 50

export function AppCombobox({
  label, value, onChange, options, loading = false, required = false, disabled = false,
  placeholder, emptyHint = 'Sin sugerencias. Podés escribirlo igual.', error, hint,
  id, autoCapitalize, 'data-testid': testId,
}: AppComboboxProps) {
  const reactId = useId()
  const inputId = id ?? `combobox-${reactId}`
  const listId = `${inputId}-listbox`

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<AnchoredPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    const query = normalizeText(value)
    const pool = query
      ? options.filter(option => normalizeText(option).includes(query))
      : options
    return pool.slice(0, MAX_VISIBLE)
  }, [options, value])

  /**
   * Cerrar al tocar fuera.
   *
   * La lista vive en un portal, así que NO es descendiente de `rootRef`:
   * comprobar sólo ese contenedor haría que un tap sobre una opción se leyera
   * como click afuera y cerrara el desplegable antes de elegir. Por eso
   * «adentro» son las dos cosas: el campo y la lista portaleada.
   */
  const isInside = useCallback((target: Node | null) =>
    Boolean(target && (rootRef.current?.contains(target) || listRef.current?.contains(target))),
  [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, isInside])

  /**
   * Posición contra el viewport. `useLayoutEffect` para que la lista no se
   * pinte un frame en (0,0) antes de ubicarse.
   */
  const reposition = useCallback(() => {
    const anchor = fieldRef.current?.getBoundingClientRect()
    if (!anchor) return
    setPosition(computeAnchoredPosition(
      { top: anchor.top, bottom: anchor.bottom, left: anchor.left, width: anchor.width },
      readViewport(),
    ))
  }, [])

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    reposition()

    // Sólo mientras está abierta: nada de listeners permanentes.
    const vv = window.visualViewport
    // `scroll` en captura para enterarse también del scroll de contenedores
    // internos, no sólo del de la página.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    vv?.addEventListener('resize', reposition)
    vv?.addEventListener('scroll', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      vv?.removeEventListener('resize', reposition)
      vv?.removeEventListener('scroll', reposition)
    }
  }, [open, reposition])

  // Al filtrar cambia la altura necesaria, así que se recalcula el volteo.
  useLayoutEffect(() => { if (open) reposition() }, [filtered.length, open, reposition])

  // El ítem activo tiene que quedar a la vista cuando se navega con flechas.
  // `scrollIntoView` se comprueba: no existe en jsdom y su ausencia no puede
  // romper la navegación por teclado, que es lo que este efecto acompaña.
  useEffect(() => {
    if (!open || active < 0) return
    const node = listRef.current?.children[active]
    if (node instanceof HTMLElement && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [open, active])

  /**
   * Salir del combobox con Tab tiene que cerrar la lista: si no, queda
   * flotando sobre el campo siguiente y tapa lo que el usuario está por
   * escribir. Se compara contra `relatedTarget` para NO cerrar cuando el foco
   * se mueve dentro del propio componente.
   */
  const onBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    // `isInside` y no `rootRef` a secas: con la lista en un portal, el foco
    // podría moverse hacia ella y eso no es «salir del combobox».
    if (!isInside(event.relatedTarget as Node | null)) {
      setOpen(false)
      setActive(-1)
    }
  }

  const commit = (option: string) => {
    onChange(option)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); setActive(0); return }
      if (!filtered.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(previous => {
        // Con la lista abierta pero nada marcado todavía (pasa al enfocar),
        // bajar entra por arriba y subir entra por abajo. Sin este caso,
        // ArrowUp caía en un índice del medio, que no significa nada.
        if (previous < 0) return step === 1 ? 0 : filtered.length - 1
        return (previous + step + filtered.length) % filtered.length
      })
      return
    }
    if (event.key === 'Enter' && open && active >= 0 && filtered[active]) {
      // Sólo se intercepta si hay una sugerencia marcada: si no, Enter tiene
      // que seguir enviando el formulario.
      event.preventDefault()
      commit(filtered[active])
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'Home' && open) { event.preventDefault(); setActive(0) }
    if (event.key === 'End' && open) { event.preventDefault(); setActive(filtered.length - 1) }
  }

  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="app-combobox" ref={rootRef} onBlur={onBlurCapture}>
      {/* El asterisco de requerido va por CSS, no como nodo de texto: si
          entra al `<label>`, el nombre accesible pasa a ser «Marca *» y deja
          de coincidir con el label a secas. `AppInput` ya resuelve así, y la
          obligatoriedad se comunica además con `aria-required`. */}
      <label htmlFor={inputId} className={`form-label${required ? ' is-required' : ''}`}>{label}</label>

      <div className="app-combobox-field" ref={fieldRef}>
        <input
          id={inputId}
          className="form-control"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && active >= 0 ? `${inputId}-option-${active}` : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          autoComplete="off"
          autoCapitalize={autoCapitalize}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          data-testid={testId}
          onChange={event => { onChange(event.target.value); setOpen(true); setActive(-1) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="app-combobox-toggle"
          // El input ya es el control accesible; el chevron es afordancia
          // visual y no debe aparecer como una parada más del tabulador.
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* El nombre de la lista NO puede ser el del campo: con los dos
          llamándose «Marca», cualquier consulta por nombre accesible resuelve
          a dos elementos y se vuelve ambigua. */}
      {open && position && createPortal(
        <ul
          className={`app-combobox-list is-${position.placement}`}
          id={listId}
          role="listbox"
          ref={listRef}
          aria-label={`Sugerencias de ${label}`}
          data-placement={position.placement}
          /**
           * `position: fixed` con coordenadas de `getBoundingClientRect()`:
           * el mismo sistema de referencia, y ningún ancestro puede recortarla
           * porque ya no cuelga del formulario.
           */
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          /**
           * `mousedown` con preventDefault mantiene el foco en el input, que
           * es lo que evita que `focusout` cierre la lista antes de que llegue
           * el `click`.
           *
           * Va en `mousedown` y NO en `pointerdown`: el navegador sintetiza
           * `mousedown` sólo cuando ya decidió que el gesto fue un TAP, no
           * mientras se scrollea. `pointerdown` se dispara al apoyar el dedo,
           * así que hacer preventDefault ahí bloqueaba el desplazamiento.
           */
          onMouseDown={event => event.preventDefault()}
        >
          {loading && !filtered.length && (
            <li className="app-combobox-status" role="presentation">Buscando…</li>
          )}
          {!loading && !filtered.length && (
            <li className="app-combobox-status" role="presentation">{emptyHint}</li>
          )}
          {filtered.map((option, index) => (
            <li
              key={option}
              id={`${inputId}-option-${index}`}
              role="option"
              aria-selected={option === value}
              className={`app-combobox-option${index === active ? ' is-active' : ''}${option === value ? ' is-selected' : ''}`}
              /**
               * Se elige en `click`, no en `pointerdown`.
               *
               * Con `pointerdown`, apoyar el dedo sobre una opción para
               * empezar a desplazar una lista de 50 elementos la seleccionaba
               * y cerraba el desplegable: el scroll táctil era imposible.
               *
               * `click` sólo se dispara si el gesto terminó siendo un tap —
               * el navegador ya lo suprime cuando hubo desplazamiento — y
               * cubre mouse, touch y Enter con el mismo camino.
               */
              onClick={() => commit(option)}
            >
              <span>{option}</span>
              {option === value && <Check size={16} aria-hidden="true" />}
            </li>
          ))}
        </ul>,
        document.body,
      )}

      {error && <p id={`${inputId}-error`} className="form-error">{error}</p>}
      {hint && !error && <p id={`${inputId}-hint`} className="form-hint">{hint}</p>}
    </div>
  )
}
