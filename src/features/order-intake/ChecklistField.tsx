import type { CheckResult } from './model'

/**
 * ORDERS-V2-0 — control rápido de verificación para la recepción.
 *
 * Reemplaza al `<select>` nativo por radios reales presentados como segmented
 * control. El motivo es de mostrador, no estético: el paso tenía ocho selects,
 * y completarlo en un teléfono significaba abrir y confirmar ocho ruedas
 * nativas de iOS. Con radios, marcar los ocho son ocho toques.
 *
 * Se usan `<input type="radio">` de verdad — no botones con `aria-*` — para
 * heredar sin código el recorrido con flechas, el agrupado por `name`, el
 * anuncio del lector de pantalla y el foco visible del navegador.
 *
 * CONTRATO: el valor emitido es exactamente el `CheckResult` que ya viajaba
 * antes. `intake_check_results` no cambia, la RPC no cambia, la DB no cambia.
 */

export const CHECK_RESULT_OPTIONS: { value: CheckResult; label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'fail', label: 'Falla' },
  { value: 'not_tested', label: 'No probado' },
  // `not_applicable` ya está soportado end-to-end: lo acepta el tipo
  // `CheckResult` y lo valida `create_order_intake` contra
  // ('ok','fail','not_tested','not_applicable'). No requiere cambio de schema.
  { value: 'not_applicable', label: 'No aplica' },
]

export interface ChecklistFieldProps {
  /** Clave que viaja en `intake_check_results` (p. ej. `display`). */
  name: string
  /** Etiqueta visible del ítem verificado (p. ej. «Pantalla»). */
  label: string
  value: CheckResult
  onChange: (value: CheckResult) => void
}

export function ChecklistField({ name, label, value, onChange }: ChecklistFieldProps) {
  const labelId = `intake-check-${name}-label`

  return (
    <div className="intake-check-row">
      <span className="intake-check-row-label" id={labelId}>{label}</span>
      <div className="intake-check-seg" role="radiogroup" aria-labelledby={labelId}>
        {CHECK_RESULT_OPTIONS.map(option => (
          <label
            key={option.value}
            className={`intake-check-opt${value === option.value ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              name={`intake-check-${name}`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              /**
               * El nombre accesible incluye el ítem porque en la pantalla
               * conviven ocho grupos con las mismas cuatro opciones: «OK» a
               * secas es ambiguo para un lector de pantalla y para un test.
               */
              aria-label={`${label}: ${option.label}`}
            />
            <span aria-hidden="true">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
