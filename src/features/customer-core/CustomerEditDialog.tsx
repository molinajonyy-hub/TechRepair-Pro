import { useRef, useState } from 'react'
import { customersService } from '../../services/api'
import type { Customer } from '../../lib/supabase'
import { AppButton, ResponsiveDialog } from '../../ui'
import { CustomerCreateFields } from './CustomerCreateFields'
import type { CustomerCoreRecord } from './model'
import { useCustomerCore } from './useCustomerCore'

/** El CTA vive en el footer del diálogo, fuera del `<form>`. */
const CUSTOMER_EDIT_FORM_ID = 'customer-edit-form'

export type EditableCustomer = CustomerCoreRecord & { id: string }

export interface CustomerEditDialogProps {
  /** Fila a editar. `null` = diálogo cerrado. */
  customer: EditableCustomer | null
  onClose: () => void
  /** La fila tal como la devolvió el servidor después de guardar. */
  onSaved: (saved: Customer) => void | Promise<void>
}

/**
 * CLIENTES-UX-1A — edición de cliente, una sola para el listado y la ficha.
 *
 * Antes vivía dentro de `Customers.tsx` y la ficha individual no tenía forma
 * de editar. Ahora las dos superficies montan este diálogo: el mismo cuerpo
 * que las altas (`CustomerCreateFields`), las mismas reglas (`useCustomerCore`)
 * y el mismo guardado (`customersService.update`).
 *
 * El cuerpo se monta con `key` por cliente: el formulario se hidrata en el
 * primer render desde la fila, sin un render intermedio vacío.
 */
export function CustomerEditDialog({ customer, onClose, onSaved }: CustomerEditDialogProps) {
  if (!customer) return null
  return <CustomerEditDialogBody key={customer.id} customer={customer} onClose={onClose} onSaved={onSaved} />
}

function CustomerEditDialogBody({
  customer,
  onClose,
  onSaved,
}: Omit<CustomerEditDialogProps, 'customer'> & { customer: EditableCustomer }) {
  // PRE-BETA-3A-2 — el core también resuelve el gate Mayorista. Sin gate, un
  // mayorista existente queda `preserved`: se editan sus datos comunes y el
  // PATCH no toca tipo, razón social ni contacto.
  const { attemptSubmit, toUpdatePayload, fieldProps } = useCustomerCore({ mode: 'update', initial: customer })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const saveLock = useRef(false)

  const save = async () => {
    if (saveLock.current) return
    // El motivo se muestra al lado del campo que falla (el intento lo revela);
    // el aviso de arriba queda para errores del servidor.
    if (!attemptSubmit()) return
    saveLock.current = true
    setSaving(true)
    setError('')
    try {
      const saved = await customersService.update(customer.id, toUpdatePayload())
      await onSaved(saved)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'No se pudieron guardar los cambios. Intentá de nuevo.')
      setSaving(false)
      saveLock.current = false
    }
  }

  return (
    <ResponsiveDialog
      isOpen
      onClose={onClose}
      title="Editar Cliente"
      subtitle={customer.name ?? undefined}
      size="lg"
      mobilePresentation="fullscreen"
      footer={(
        <div className="customer-create-dialog-actions">
          <AppButton variant="secondary" onClick={onClose}>
            Cancelar
          </AppButton>
          <AppButton
            type="submit"
            form={CUSTOMER_EDIT_FORM_ID}
            variant="primary"
            loading={saving}
            data-testid="customer-edit-save-button"
          >
            Guardar cambios
          </AppButton>
        </div>
      )}
    >
      <form
        id={CUSTOMER_EDIT_FORM_ID}
        className="customer-create-form"
        onSubmit={event => { event.preventDefault(); void save() }}
        noValidate
      >
        {error && (
          <p className="form-error customer-create-server-error" role="alert" data-testid="customer-edit-error">
            {error}
          </p>
        )}
        <CustomerCreateFields {...fieldProps} additionalInitiallyOpen />
      </form>
    </ResponsiveDialog>
  )
}
