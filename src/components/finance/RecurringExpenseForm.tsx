import { useCallback, useId, useRef, useState, type FormEvent } from 'react'
import { recurringExpenseError, type RecurringExpense, type useRecurringExpenses } from '../../hooks/useRecurringExpenses'
import { ENTRY_TYPES } from '../../services/financeService'
import { formatAmount } from '../../lib/money'
import { parseLocalizedAmount } from '../../features/order-intake/model'
import { AppButton, AppInput, AppModal, AppMoneyInput, AppSelect, AppTextarea, FormGrid } from '../../ui'

const templateTypes = ENTRY_TYPES.filter(type => type.value === 'fixed_cost_local' || type.value === 'salary')
type Operations = Pick<ReturnType<typeof useRecurringExpenses>, 'create' | 'update'>

interface Props extends Operations {
  expense: RecurringExpense | null
  businessId: string
  onClose: () => void
  onSaved: () => void
}

export function RecurringExpenseForm({ expense, businessId, create, update, onClose, onSaved }: Props) {
  const formId = useId()
  const [name, setName] = useState(expense?.name ?? '')
  const [amount, setAmount] = useState(expense ? formatAmount(expense.amount) : '')
  const [currency, setCurrency] = useState<RecurringExpense['currency']>(expense?.currency ?? 'ARS')
  const [day, setDay] = useState(String(expense?.day_of_month ?? 1))
  const [notes, setNotes] = useState(expense?.notes ?? '')
  const [type, setType] = useState(templateTypes[0].value)
  const [category, setCategory] = useState(templateTypes[0].categories[0].value)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState<{ name?: string; amount?: string; day?: string }>({})
  const categories = templateTypes.find(item => item.value === type)!.categories
  const close = useCallback(() => { if (!savingRef.current) onClose() }, [onClose])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current) return
    const parsedAmount = parseLocalizedAmount(amount)
    const parsedDay = Number(day)
    const errors = {
      name: name.trim() ? undefined : 'Ingresá un nombre.',
      amount: parsedAmount !== null && Number.isFinite(parsedAmount) && parsedAmount >= 0 ? undefined : 'Ingresá un importe válido, igual o mayor a cero.',
      day: Number.isInteger(parsedDay) && parsedDay >= 1 && parsedDay <= 28 ? undefined : 'Elegí un día entre 1 y 28.',
    }
    setValidation(errors)
    if (errors.name || errors.amount || errors.day || parsedAmount === null) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const fields = { name: name.trim(), amount: parsedAmount, currency, day_of_month: parsedDay, notes: notes.trim() }
      if (expense) await update(expense.id, fields)
      else await create({ ...fields, business_id: businessId, type, category, is_active: true })
      onSaved()
    } catch (cause) {
      setError(recurringExpenseError(cause))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <AppModal isOpen onClose={close} title={expense ? 'Editar gasto recurrente' : 'Nuevo gasto recurrente'}
      subtitle="Configuración mensual. No registra movimientos ni pagos." size="md" mobilePresentation="sheet"
      closeOnBackdrop={!saving}
      footer={<div className="recurring-expenses__actions">
        <AppButton disabled={saving} onClick={close}>Cancelar</AppButton>
        <AppButton type="submit" form={formId} variant="primary" loading={saving}>{saving ? 'Guardando…' : 'Guardar recurrente'}</AppButton>
      </div>}
    >
      <form id={formId} onSubmit={event => void submit(event)} className="recurring-expenses__form" noValidate>
        <fieldset disabled={saving}>
          <AppInput id={`${formId}-name`} label="Nombre / concepto" value={name} onChange={event => setName(event.target.value)} error={validation.name} required />
          {!expense && <FormGrid>
            <AppSelect id={`${formId}-type`} label="Tipo de gasto" value={type} options={templateTypes} onChange={event => {
              const selected = templateTypes.find(item => item.value === event.target.value)!
              setType(selected.value)
              setCategory(selected.categories[0].value)
            }} />
            <AppSelect id={`${formId}-category`} label="Categoría" value={category} options={categories} onChange={event => setCategory(event.target.value)} />
          </FormGrid>}
          <AppMoneyInput label="Importe mensual" value={amount} onValueChange={setAmount} currency={currency} onCurrencyChange={setCurrency} disabled={saving} error={validation.amount} />
          <AppInput id={`${formId}-day`} label="Día del mes" type="number" inputMode="numeric" min={1} max={28} step={1} value={day} onChange={event => setDay(event.target.value)} error={validation.day} hint="Entre el 1 y el 28 de cada mes." required />
          <AppTextarea id={`${formId}-notes`} label="Notas (opcional)" value={notes} onChange={event => setNotes(event.target.value)} />
        </fieldset>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
      </form>
    </AppModal>
  )
}
