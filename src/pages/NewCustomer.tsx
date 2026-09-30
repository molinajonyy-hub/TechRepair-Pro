import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, UserPlus } from 'lucide-react'
import { CustomerCreateFields, useCustomerCore } from '../features/customer-core'
import { customersService } from '../services/api'
import { AppButton, AppPageHeader, MobileActionBar } from '../ui'

export function NewCustomer() {
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const submitLock = useRef(false)

  const { attemptSubmit, toCreatePayload, fieldProps } = useCustomerCore()

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitLock.current) return
    // PRE-BETA-3A-2 — el CTA sólo lo bloquea el guardado en curso. Intentar
    // guardar revela los bloqueos en sus campos; si hay alguno, no se escribe.
    if (!attemptSubmit()) return

    submitLock.current = true
    setIsSubmitting(true)
    setError('')

    try {
      const customer = await customersService.create(toCreatePayload())

      navigate(`/customers/${customer.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error al crear el cliente')
      setIsSubmitting(false)
      submitLock.current = false
    }
  }

  const cancel = () => navigate('/customers')

  return (
    <div className="animate-fade-in-fast customer-create-page">
      <AppPageHeader
        icon={<UserPlus size={20} aria-hidden="true" />}
        title="Nuevo Cliente"
        description="Registrá un nuevo cliente en el sistema"
        actions={(
          <AppButton variant="secondary" size="sm" leftIcon={<ArrowLeft size={15} />} onClick={cancel}>
            Volver
          </AppButton>
        )}
      />

      {error && (
        <div className="alert-inline alert-error customer-create-server-error" role="alert">
          {error}
        </div>
      )}

      <div className="card customer-create-card">
        <div className="card-body">
          <form className="customer-create-form" onSubmit={handleSubmit} noValidate>
            <CustomerCreateFields {...fieldProps} additionalInitiallyOpen />

            <div className="customer-create-action-host">
              <MobileActionBar
                className="customer-create-responsive-actions"
                label="Acciones de alta de cliente"
                secondaryAction={(
                  <AppButton variant="secondary" fullWidth onClick={cancel}>
                    Cancelar
                  </AppButton>
                )}
                primaryAction={(
                  <AppButton
                    type="submit"
                    variant="primary"
                    fullWidth
                    leftIcon={<Save size={16} />}
                    loading={isSubmitting}
                    data-testid="customer-save-button"
                  >
                    Guardar cliente
                  </AppButton>
                )}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
