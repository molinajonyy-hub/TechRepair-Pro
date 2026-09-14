import { forwardRef, useImperativeHandle, useRef } from 'react'
import { AppInput } from '../../../ui'
import { formatCuitInput, type ArcaFiscalDraft, type ArcaFiscalField } from '../../../lib/arcaFiscalInput'

export interface ArcaFiscalStepHandle {
  /** Lleva el foco al primer campo con error. */
  focusField: (field: ArcaFiscalField) => void
}

interface ArcaFiscalStepProps {
  draft: ArcaFiscalDraft
  errors: Partial<Record<ArcaFiscalField, string>>
  disabled: boolean
  onChange: (next: ArcaFiscalDraft) => void
  onBlurField: (field: ArcaFiscalField) => void
}

const AMBIENTES = [
  { value: 'produccion', title: 'Producción', detail: 'Comprobantes reales, con validez fiscal.' },
  { value: 'homologacion', title: 'Homologación', detail: 'Ambiente de pruebas de ARCA. Sin validez fiscal.' },
] as const

/** Paso 1 — datos fiscales. Formato amable; la validación definitiva es del servidor. */
export const ArcaFiscalStep = forwardRef<ArcaFiscalStepHandle, ArcaFiscalStepProps>(function ArcaFiscalStep(
  { draft, errors, disabled, onChange, onBlurField }, ref,
) {
  const inputs = useRef<Partial<Record<ArcaFiscalField, HTMLInputElement | null>>>({})
  useImperativeHandle(ref, () => ({
    focusField: (field) => inputs.current[field]?.focus(),
  }), [])

  const set = (patch: Partial<ArcaFiscalDraft>) => onChange({ ...draft, ...patch })

  return (
    <div className="arca-setup-form" data-testid="arca-setup-fiscal">
      <AppInput
        id="arca-setup-cuit"
        data-testid="arca-setup-cuit"
        ref={(el) => { inputs.current.cuit = el }}
        label="CUIT del negocio"
        semantic="numeric"
        autoComplete="off"
        placeholder="XX-XXXXXXXX-X"
        maxLength={13}
        value={draft.cuit}
        onChange={(e) => set({ cuit: formatCuitInput(e.target.value) })}
        onBlur={() => onBlurField('cuit')}
        error={errors.cuit}
        hint="El CUIT que factura. Tiene 11 dígitos."
        disabled={disabled}
        required
      />

      <AppInput
        id="arca-setup-razon-social"
        data-testid="arca-setup-razon-social"
        ref={(el) => { inputs.current.razon_social = el }}
        label="Razón social"
        autoComplete="organization"
        maxLength={200}
        value={draft.razonSocial}
        onChange={(e) => set({ razonSocial: e.target.value })}
        onBlur={() => onBlurField('razon_social')}
        error={errors.razon_social}
        hint="Tal como figura en ARCA."
        disabled={disabled}
        required
      />

      <fieldset className="arca-setup-fieldset" aria-describedby={errors.ambiente ? 'arca-setup-ambiente-error' : 'arca-setup-ambiente-hint'}>
        <legend className="form-label">Dónde vas a emitir</legend>
        <div className="arca-setup-choice-grid">
          {AMBIENTES.map((option, index) => (
            <label key={option.value} className={`arca-setup-choice${draft.ambiente === option.value ? ' is-selected' : ''}`} data-testid={`arca-setup-ambiente-${option.value}`}>
              <input
                type="radio"
                name="arca-setup-ambiente"
                value={option.value}
                checked={draft.ambiente === option.value}
                onChange={() => set({ ambiente: option.value })}
                onBlur={() => onBlurField('ambiente')}
                ref={index === 0 ? (el) => { inputs.current.ambiente = el } : undefined}
                disabled={disabled}
                aria-invalid={!!errors.ambiente}
              />
              <span className="arca-setup-choice__title">{option.title}</span>
              <span className="arca-setup-choice__detail">{option.detail}</span>
            </label>
          ))}
        </div>
        {errors.ambiente
          ? <p id="arca-setup-ambiente-error" className="form-error">{errors.ambiente}</p>
          : <p id="arca-setup-ambiente-hint" className="form-hint">Si vas a facturar de verdad, elegí Producción.</p>}
      </fieldset>

      <AppInput
        id="arca-setup-punto-venta"
        data-testid="arca-setup-punto-venta"
        ref={(el) => { inputs.current.punto_venta = el }}
        label="Punto de venta"
        semantic="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder="Ej: 2"
        value={draft.puntoVenta}
        onChange={(e) => set({ puntoVenta: e.target.value.replace(/\D/g, '').slice(0, 5) })}
        onBlur={() => onBlurField('punto_venta')}
        error={errors.punto_venta}
        hint="El número del punto de venta de ARCA habilitado para factura electrónica."
        disabled={disabled}
        required
      />

      <AppInput
        id="arca-setup-alias"
        data-testid="arca-setup-alias"
        ref={(el) => { inputs.current.alias = el }}
        label="Nombre del equipo en ARCA"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={50}
        value={draft.alias}
        onChange={(e) => set({ alias: e.target.value })}
        onBlur={() => onBlurField('alias')}
        error={errors.alias}
        hint="Con este nombre ARCA identifica a TechRepair Pro. Te sugerimos uno; podés cambiarlo."
        disabled={disabled}
        required
      />
    </div>
  )
})
