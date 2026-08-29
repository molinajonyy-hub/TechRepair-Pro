import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, UserPlus } from 'lucide-react'
import {
  CustomerCreateFields,
  firstCustomerCoreError,
  useCustomerCore,
} from '../features/customer-core'
import { customersService } from '../services/api'
import { AppButton, MobileActionBar } from '../ui'

export function NewCustomer() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const submitLock = useRef(false)

  const { values, errors, setField, setCustomerType, toCreatePayload } = useCustomerCore()

  const returnTo = location.state?.returnTo || '/customers'

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitLock.current || firstCustomerCoreError(errors)) return

    submitLock.current = true
    setIsSubmitting(true)
    setError('')

    try {
      const customer = await customersService.create(toCreatePayload())

      if (returnTo === '/orders/new') {
        navigate('/orders/new', {
          state: {
            selectedCustomer: customer,
            step: 'customer',
          },
        })
      } else {
        navigate(`/customers/${customer.id}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Error al crear el cliente')
      setIsSubmitting(false)
      submitLock.current = false
    }
  }

  const cancel = () => navigate(returnTo)
  const invalid = Object.keys(errors).length > 0

  return (
    <div className="animate-fade-in-fast customer-create-page">
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <UserPlus size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="page-hdr-title">Nuevo Cliente</h1>
            <p className="page-hdr-subtitle">Registrá un nuevo cliente en el sistema</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <AppButton variant="secondary" size="sm" leftIcon={<ArrowLeft size={15} />} onClick={cancel}>
            Volver
          </AppButton>
        </div>
      </div>

      {error && (
        <div className="alert-inline alert-error customer-create-server-error" role="alert">
          {error}
        </div>
      )}

      <div className="card customer-create-card">
        <div className="card-header customer-create-card-header">
          <div className="customer-create-card-title">
            <UserPlus size={18} aria-hidden="true" />
            <h2 className="card-title">Información del cliente</h2>
          </div>
        </div>
        <div className="card-body">
          <form className="customer-create-form" onSubmit={handleSubmit} noValidate>
            <CustomerCreateFields
              values={values}
              errors={errors}
              setField={setField}
              setCustomerType={setCustomerType}
              additionalInitiallyOpen
            />

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
                    disabled={invalid}
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
