import { useCallback, useRef, useState } from 'react'
import { Plus, Repeat2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useRecurringExpenses, recurringExpenseError, type RecurringExpense } from '../../hooks/useRecurringExpenses'
import { formatMoney } from '../../lib/money'
import { AppBadge, AppButton, AppEmptyState, AppErrorState, AppLoadingState, AppSelect } from '../../ui'
import { RecurringExpenseForm } from './RecurringExpenseForm'
import './RecurringExpensesPanel.css'

// Cambiar de negocio descarta formularios y mensajes del negocio anterior.
export function RecurringExpensesPanel() {
  const { businessId } = useAuth()
  return <RecurringExpensesContent key={businessId ?? 'no-business'} />
}

function RecurringExpensesContent() {
  const { businessId } = useAuth()
  const { expenses, loading, error, load, create, update } = useRecurringExpenses({
    includeInactive: true, includePaymentStatus: false,
  })
  const [filter, setFilter] = useState('active')
  const [editing, setEditing] = useState<RecurringExpense | 'new' | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const closeForm = useCallback(() => setEditing(null), [])
  const visible = expenses.filter(expense => filter === 'all' || expense.is_active === (filter === 'active'))

  const openForm = (expense: RecurringExpense | 'new') => {
    setActionError(null)
    setMessage('')
    setEditing(expense)
  }

  const toggleActive = async (expense: RecurringExpense) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(expense.id)
    setActionError(null)
    setMessage('')
    try {
      await update(expense.id, { is_active: !expense.is_active })
      setMessage(`${expense.name}: ${expense.is_active ? 'desactivado' : 'reactivado'}.`)
    } catch (cause) {
      setActionError(recurringExpenseError(cause))
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  return (
    <section className="recurring-expenses" aria-labelledby="recurring-expenses-title">
      <div className="recurring-expenses__header">
        <div>
          <h2 id="recurring-expenses-title">Gastos recurrentes</h2>
          <p>Plantillas de gastos que se repiten cada mes. Guardarlas no registra un gasto ni un pago.</p>
        </div>
        <AppButton variant="primary" leftIcon={<Plus size={16} />} disabled={!businessId || !!pending} onClick={() => openForm('new')}>
          Nuevo recurrente
        </AppButton>
      </div>
      <div className="recurring-expenses__filter">
        <AppSelect label="Mostrar recurrentes" value={filter} onChange={event => setFilter(event.target.value)} options={[
          { value: 'active', label: 'Activos' }, { value: 'inactive', label: 'Inactivos' }, { value: 'all', label: 'Todos' },
        ]} />
      </div>
      {message && <p role="status" className="recurring-expenses__feedback">{message}</p>}
      {actionError && <div role="alert"><AppErrorState message={actionError} /></div>}
      {loading ? (
        <div role="status" aria-label="Cargando gastos recurrentes"><AppLoadingState rows={3} type="list" /></div>
      ) : error ? (
        <div role="alert"><AppErrorState message={error} onRetry={() => void load()} /></div>
      ) : visible.length === 0 ? (
        <AppEmptyState icon={<Repeat2 size={24} />} compact
          title={expenses.length === 0 ? 'Todavía no hay gastos recurrentes' : `No hay recurrentes ${filter === 'inactive' ? 'inactivos' : 'activos'}`}
          description={expenses.length === 0 ? 'Creá una plantilla para organizar los gastos que se repiten cada mes.' : 'Cambiá el filtro para ver las demás plantillas.'}
          action={expenses.length === 0 ? { label: 'Crear gasto recurrente', onClick: () => openForm('new') } : undefined}
        />
      ) : (
        <ul className="recurring-expenses__list">
          {visible.map(expense => (
            <li key={expense.id} className="recurring-expenses__row">
              <div className="recurring-expenses__detail">
                <h3>{expense.name}</h3>
                <p>Mensual · Día {expense.day_of_month}</p>
                <AppBadge variant={expense.is_active ? 'active' : 'neutral'}>{expense.is_active ? 'Activo' : 'Inactivo'}</AppBadge>
              </div>
              <strong className="recurring-expenses__amount">{formatMoney(expense.amount, expense.currency)} <small>{expense.currency}</small></strong>
              <div className="recurring-expenses__actions">
                <AppButton disabled={!!pending} aria-label={`Editar ${expense.name}`} onClick={() => openForm(expense)}>Editar</AppButton>
                <AppButton disabled={!!pending} loading={pending === expense.id} aria-label={`${expense.is_active ? 'Desactivar' : 'Reactivar'} ${expense.name}`} onClick={() => void toggleActive(expense)}>
                  {expense.is_active ? 'Desactivar' : 'Reactivar'}
                </AppButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && businessId && (
        <RecurringExpenseForm expense={editing === 'new' ? null : editing} businessId={businessId}
          create={create} update={update} onClose={closeForm}
          onSaved={() => {
            setFilter(editing === 'new' || editing.is_active ? 'active' : 'inactive')
            setMessage(editing === 'new' ? 'Gasto recurrente creado.' : 'Gasto recurrente actualizado.')
            closeForm()
          }}
        />
      )}
    </section>
  )
}
