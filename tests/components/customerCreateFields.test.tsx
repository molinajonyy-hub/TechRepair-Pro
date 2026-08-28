import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CustomerCreateFields,
  EMPTY_CUSTOMER_CORE,
  type CustomerCoreErrors,
  type CustomerCoreValues,
} from '../../src/features/customer-core'

function renderFields({
  values = EMPTY_CUSTOMER_CORE,
  errors = {},
  additionalInitiallyOpen = false,
}: {
  values?: CustomerCoreValues
  errors?: CustomerCoreErrors
  additionalInitiallyOpen?: boolean
} = {}) {
  const setField = vi.fn()
  const setCustomerType = vi.fn()
  const view = render(
    <CustomerCreateFields
      values={values}
      errors={errors}
      setField={setField}
      setCustomerType={setCustomerType}
      additionalInitiallyOpen={additionalInitiallyOpen}
    />
  )
  return { ...view, setField, setCustomerType }
}

describe('CUSTOMER-CREATION-PARITY-1A · cuerpo canónico', () => {
  it('mantiene la jerarquía pactada y no incorpora ciudad', () => {
    const values = {
      ...EMPTY_CUSTOMER_CORE,
      customerType: 'mayorista' as const,
      documentType: 'cuit' as const,
    }
    const { container } = renderFields({ values })
    const sections = Array.from(container.querySelectorAll('.customer-create-section')).map((section) =>
      section.querySelector('.customer-create-section-title, .customer-create-disclosure')?.textContent?.trim()
    )

    expect(sections).toEqual([
      'Tipo de cliente',
      'Datos principales',
      'Datos mayoristas',
      'Datos adicionales (opcional)',
    ])
    expect(screen.getByLabelText('Nombre completo')).toBeInTheDocument()
    expect(screen.getByLabelText('Teléfono')).toBeInTheDocument()
    expect(screen.getByLabelText('Razón social')).toBeInTheDocument()
    expect(screen.getByLabelText('Persona de contacto')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Ciudad/i)).not.toBeInTheDocument()
  })

  it('usa controles segmentados con estado programático para cliente y documento', () => {
    const { setField, setCustomerType } = renderFields()

    const retail = screen.getByTestId('customer-type-minorista')
    const wholesale = screen.getByTestId('customer-type-mayorista')
    expect(retail).toHaveClass('seg-field-option')
    expect(retail).toHaveAttribute('aria-pressed', 'true')
    expect(wholesale).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(wholesale)
    expect(setCustomerType).toHaveBeenCalledWith('mayorista')

    const dni = screen.getByTestId('customer-document-type-dni')
    const cuit = screen.getByTestId('customer-document-type-cuit')
    expect(dni).toHaveClass('seg-field-option')
    expect(dni).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(cuit)
    expect(setField).toHaveBeenCalledWith('documentType', 'cuit')
  })

  it('mantiene el documento como texto libre y acepta letras y separadores', () => {
    const { setField } = renderFields()
    const document = screen.getByTestId('customer-document-input')

    expect(document).toHaveProperty('type', 'text')
    expect(document).not.toHaveAttribute('inputmode', 'numeric')
    fireEvent.change(document, { target: { value: 'AB-123.456' } })
    expect(setField).toHaveBeenCalledWith('document', 'AB-123.456')
  })

  it('abre o colapsa datos adicionales según el shell y conserva todos los campos', () => {
    renderFields()
    const toggle = screen.getByTestId('customer-additional-toggle')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('Email')).not.toBeVisible()
    expect(screen.getByLabelText('Dirección')).not.toBeVisible()
    expect(screen.getByLabelText('Notas')).not.toBeVisible()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Email')).toBeVisible()
    expect(screen.getByLabelText('Dirección')).toBeVisible()
    expect(screen.getByLabelText('Notas')).toBeVisible()
  })

  it('asocia los errores al campo y revela un email inválido aunque el bloque empezara cerrado', async () => {
    renderFields({
      errors: {
        name: 'El nombre es obligatorio.',
        phone: 'El teléfono es obligatorio.',
        email: 'Ingresá un email válido.',
      },
    })

    for (const label of ['Nombre completo', 'Teléfono', 'Email']) {
      const input = screen.getByLabelText(label)
      const describedBy = input.getAttribute('aria-describedby')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy!)).toBeInTheDocument()
    }
    await waitFor(() => expect(screen.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByText('Ingresá un email válido.')).toBeVisible()
  })

  it('empieza expandido cuando lo solicita la página completa', () => {
    renderFields({ additionalInitiallyOpen: true })
    expect(screen.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Notas')).toBeVisible()
  })
})
