import { useEffect, useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { AppInput, AppTextarea, FormGrid } from '../../ui'
import { DOCUMENT_TYPES } from './document'
import type {
  CustomerCoreErrors,
  CustomerCoreField,
  CustomerCoreValues,
  CustomerType,
} from './model'

export interface CustomerCreateFieldsProps {
  values: CustomerCoreValues
  errors: CustomerCoreErrors
  setField: (field: CustomerCoreField, value: string) => void
  setCustomerType: (customerType: CustomerType) => void
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
 */
export function CustomerCreateFields({
  values,
  errors,
  setField,
  setCustomerType,
  additionalInitiallyOpen = false,
}: CustomerCreateFieldsProps) {
  const [additionalOpen, setAdditionalOpen] = useState(additionalInitiallyOpen)
  const additionalId = useId()

  // Un email inválido nunca queda escondido detrás del disclosure mientras el
  // CTA está deshabilitado.
  useEffect(() => {
    if (errors.email) setAdditionalOpen(true)
  }, [errors.email])

  return (
    <div className="customer-create-fields">
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

      {values.customerType === 'mayorista' && (
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
