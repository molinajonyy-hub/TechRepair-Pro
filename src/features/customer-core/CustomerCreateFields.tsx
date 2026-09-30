import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import { AppInput, AppTextarea, FormGrid } from '../../ui'
import { DOCUMENT_TYPES } from './document'
import type { CustomerCoreField, CustomerType } from './model'
import type { CustomerCoreFieldProps } from './useCustomerCore'

export interface CustomerCreateFieldsProps extends CustomerCoreFieldProps {
  additionalInitiallyOpen?: boolean
}

const CUSTOMER_TYPE_OPTIONS: ReadonlyArray<{ value: CustomerType; label: string }> = [
  { value: 'minorista', label: 'Minorista' },
  { value: 'mayorista', label: 'Mayorista' },
]

/**
 * Cuerpo visual canónico de las altas de cliente.
 *
 * El estado, la validación y el payload siguen perteneciendo al Customer Core;
 * cada shell conserva por separado su submit, navegación y manejo de errores
 * del servicio.
 *
 * PRE-BETA-3A-2 — el tipo de cliente se dibuja según el acceso que resolvió el
 * core, no según un rol:
 *  - `full`      → selector Minorista / Mayorista, como siempre;
 *  - `retail`    → no hay nada que elegir: el cliente es minorista y no se
 *                  ofrece una opción que el actor no puede usar;
 *  - `preserved` → mayorista existente, visible y bloqueado, con sus datos
 *                  mayoristas de sólo lectura.
 */
export function CustomerCreateFields({
  values,
  errors,
  customerTypeAccess,
  setField,
  setCustomerType,
  onFieldBlur,
  submitCount = 0,
  additionalInitiallyOpen = false,
}: CustomerCreateFieldsProps) {
  const [additionalOpen, setAdditionalOpen] = useState(additionalInitiallyOpen)
  const additionalId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef(false)

  // Un email inválido nunca queda escondido detrás del disclosure cuando se
  // muestra: ni al tocarlo ni al intentar guardar con el bloque cerrado.
  useEffect(() => {
    if (errors.email) setAdditionalOpen(true)
  }, [errors.email, submitCount])

  useEffect(() => {
    if (submitCount > 0) pendingFocus.current = true
  }, [submitCount])

  // Tras un intento de envío, el foco va al primer campo que bloquea, en orden
  // de lectura. Si está dentro del disclosure todavía cerrado, espera al render
  // en que el efecto de arriba lo abre.
  useEffect(() => {
    if (!pendingFocus.current) return
    const invalid = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (!invalid) {
      pendingFocus.current = false
      return
    }
    if (invalid.closest('[hidden]')) return
    invalid.focus()
    pendingFocus.current = false
  })

  const blur = (field: CustomerCoreField) => () => onFieldBlur?.(field)
  const wholesale = values.customerType === 'mayorista'

  return (
    <div className="customer-create-fields" ref={rootRef}>
      {customerTypeAccess === 'full' && (
        <fieldset className="customer-create-fieldset customer-create-section">
          <legend className="customer-create-section-title">Tipo de cliente</legend>
          <div className="seg-field customer-create-segment">
            {CUSTOMER_TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="seg-field-option"
                data-testid={`customer-type-${option.value}`}
                aria-pressed={values.customerType === option.value}
                onClick={() => setCustomerType(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {customerTypeAccess === 'preserved' && (
        <section className="customer-create-section" aria-labelledby="customer-create-type-title">
          <h2 id="customer-create-type-title" className="customer-create-section-title">
            Tipo de cliente
          </h2>
          <div className="customer-create-type-locked" data-testid="customer-type-locked">
            <Lock aria-hidden="true" size={16} />
            <div>
              <p className="customer-create-type-locked-value">Mayorista</p>
              <p className="customer-create-type-locked-note">
                Se conserva como mayorista. Cambiar el tipo o sus datos mayoristas requiere acceso a Mayorista.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="customer-create-section" aria-labelledby="customer-create-primary-title">
        <h2 id="customer-create-primary-title" className="customer-create-section-title">
          Datos principales
        </h2>
        <div className="customer-create-section-body">
          <FormGrid>
            <AppInput
              id="customer-name"
              label="Nombre completo"
              data-testid="customer-name-input"
              value={values.name}
              error={errors.name}
              onChange={(event) => setField('name', event.target.value)}
              onBlur={blur('name')}
              placeholder="Ej: Juan Pérez"
              autoComplete="name"
              required
            />
            <AppInput
              id="customer-phone"
              semantic="tel"
              label="Teléfono"
              data-testid="customer-phone-input"
              value={values.phone}
              error={errors.phone}
              onChange={(event) => setField('phone', event.target.value)}
              onBlur={blur('phone')}
              placeholder="Ej: +54 9 11 1234-5678"
              required
            />
          </FormGrid>

          <fieldset className="customer-create-fieldset customer-create-document">
            <legend className="form-label">
              DNI / CUIT <span className="customer-create-optional-label">(opcional)</span>
            </legend>
            <div className="customer-create-document-row">
              <div className="seg-field customer-create-document-segment">
                {DOCUMENT_TYPES.map((documentType) => (
                  <button
                    key={documentType}
                    type="button"
                    className="seg-field-option"
                    data-testid={`customer-document-type-${documentType}`}
                    aria-pressed={values.documentType === documentType}
                    onClick={() => setField('documentType', documentType)}
                  >
                    {documentType.toUpperCase()}
                  </button>
                ))}
              </div>
              <AppInput
                id="customer-document"
                label="DNI / CUIT"
                noLabel
                aria-label={values.documentType.toUpperCase()}
                data-testid="customer-document-input"
                value={values.document}
                onChange={(event) => setField('document', event.target.value)}
                placeholder={values.documentType === 'dni' ? 'Ej: 30.123.456' : 'Ej: 20-30123456-7'}
                autoCapitalize="characters"
                autoComplete="off"
              />
            </div>
          </fieldset>
        </div>
      </section>

      {customerTypeAccess === 'full' && wholesale && (
        <section className="customer-create-section" aria-labelledby="customer-create-wholesale-title">
          <h2 id="customer-create-wholesale-title" className="customer-create-section-title">
            Datos mayoristas
          </h2>
          <div className="customer-create-section-body">
            <FormGrid>
              <AppInput
                id="customer-business-name"
                label="Razón social"
                data-testid="customer-business-name-input"
                value={values.businessName}
                error={errors.businessName}
                onChange={(event) => setField('businessName', event.target.value)}
                onBlur={blur('businessName')}
                autoComplete="organization"
                required
              />
              <AppInput
                id="customer-contact-person"
                label="Persona de contacto"
                data-testid="customer-contact-person-input"
                value={values.contactPerson}
                onChange={(event) => setField('contactPerson', event.target.value)}
                autoComplete="name"
              />
            </FormGrid>
            <p className="customer-create-wholesale-note">
              Al cobrarle se usarán automáticamente los precios mayoristas del inventario.
            </p>
          </div>
        </section>
      )}

      {customerTypeAccess === 'preserved' && (
        <section className="customer-create-section" aria-labelledby="customer-create-wholesale-title">
          <h2 id="customer-create-wholesale-title" className="customer-create-section-title">
            Datos mayoristas
          </h2>
          <dl className="customer-create-readonly" data-testid="customer-wholesale-readonly">
            <div>
              <dt>Razón social</dt>
              <dd data-testid="customer-business-name-readonly">{values.businessName || 'Sin cargar'}</dd>
            </div>
            <div>
              <dt>Persona de contacto</dt>
              <dd data-testid="customer-contact-person-readonly">{values.contactPerson || 'Sin cargar'}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="customer-create-section customer-create-additional">
        <h2 className="customer-create-disclosure-heading">
          <button
            type="button"
            className="customer-create-disclosure"
            aria-expanded={additionalOpen}
            aria-controls={additionalId}
            data-testid="customer-additional-toggle"
            onClick={() => setAdditionalOpen((current) => !current)}
          >
            <span>
              Datos adicionales <span className="customer-create-optional-label">(opcional)</span>
            </span>
            <ChevronDown aria-hidden="true" size={18} />
          </button>
        </h2>
        <div
          id={additionalId}
          className="customer-create-section-body customer-create-additional-body"
          hidden={!additionalOpen}
        >
          <AppInput
            id="customer-email"
            semantic="email"
            label="Email"
            data-testid="customer-email-input"
            value={values.email}
            error={errors.email}
            onChange={(event) => setField('email', event.target.value)}
            onBlur={blur('email')}
            placeholder="Ej: juan@email.com"
          />
          <FormGrid>
            <AppTextarea
              id="customer-address"
              label="Dirección"
              data-testid="customer-address-input"
              value={values.address}
              onChange={(event) => setField('address', event.target.value)}
              placeholder="Ej: Av. Corrientes 1234, CABA"
              autoComplete="street-address"
            />
            <AppTextarea
              id="customer-notes"
              label="Notas"
              data-testid="customer-notes-input"
              value={values.notes}
              onChange={(event) => setField('notes', event.target.value)}
              placeholder="Preferencias o información útil del cliente"
            />
          </FormGrid>
        </div>
      </section>
    </div>
  )
}
