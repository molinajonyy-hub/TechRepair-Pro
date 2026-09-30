/**
 * Estado compartido del formulario de cliente.
 *
 * Deliberadamente NO es un componente visual: las tres superficies se ven
 * distinto a propósito. Lo único que comparten es el estado y las reglas, y
 * eso es exactamente lo que vive acá.
 *
 * PRE-BETA-3A-2 — además vive acá, y sólo acá:
 *  - qué error se MUESTRA (tocado o intento de envío) frente a qué error
 *    EXISTE (`validateCustomerCore`, que sigue siendo la autoridad pura);
 *  - el gate Mayorista y lo que implica para el tipo de cliente.
 * Ninguna superficie implementa su propio "touched" ni su propio gate.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  EMPTY_CUSTOMER_CORE,
  applyCustomerType,
  customerCoreFromRecord,
  effectiveCustomerCoreValues,
  firstCustomerCoreError,
  resolveCustomerTypeAccess,
  toCreatePayload,
  toUpdatePayload,
  validateCustomerCore,
  type CustomerCommonUpdatePayload,
  type CustomerCoreErrors,
  type CustomerCoreField,
  type CustomerCoreMode,
  type CustomerCoreRecord,
  type CustomerCoreValues,
  type CustomerCreatePayload,
  type CustomerType,
  type CustomerTypeAccess,
  type CustomerUpdatePayload,
} from './model'
import { useWholesaleCustomerGate } from './useWholesaleCustomerGate'

export interface UseCustomerCoreOptions {
  mode?: CustomerCoreMode
  initial?: CustomerCoreRecord | CustomerCoreValues
}

/** Lo que el cuerpo visual necesita. Las superficies lo pasan tal cual. */
export interface CustomerCoreFieldProps {
  values: CustomerCoreValues
  /** Errores que corresponde MOSTRAR: nunca los de un campo sin tocar. */
  errors: CustomerCoreErrors
  customerTypeAccess: CustomerTypeAccess
  setField: (field: CustomerCoreField, value: string) => void
  setCustomerType: (customerType: CustomerType) => void
  onFieldBlur?: (field: CustomerCoreField) => void
  /** Cambia en cada intento de envío: revela y enfoca el primer bloqueo. */
  submitCount?: number
}

export interface UseCustomerCoreReturn {
  /** Valores efectivos: lo que se ve es lo que se escribe. */
  values: CustomerCoreValues
  /** Errores reales del dominio, se muestren o no. */
  errors: CustomerCoreErrors
  /** Errores que corresponde mostrar: campo tocado o intento de envío. */
  visibleErrors: CustomerCoreErrors
  isValid: boolean
  /** Primer error en orden de lectura del formulario, o ''. */
  errorMessage: string
  customerTypeAccess: CustomerTypeAccess
  submitCount: number
  setField: (field: CustomerCoreField, value: string) => void
  setCustomerType: (customerType: CustomerType) => void
  markTouched: (field: CustomerCoreField) => void
  /**
   * Intento de envío: revela TODOS los bloqueos y devuelve si se puede
   * enviar. Con `false`, la superficie no llama al servicio.
   */
  attemptSubmit: () => boolean
  /** Vuelve al estado inicial: valores, tocados, intentos y errores visibles. */
  reset: (record?: CustomerCoreRecord) => void
  toCreatePayload: () => CustomerCreatePayload
  toUpdatePayload: () => CustomerUpdatePayload | CustomerCommonUpdatePayload
  fieldProps: CustomerCoreFieldProps
}

type TouchedFields = Partial<Record<CustomerCoreField, true>>

function isCoreValues(value: CustomerCoreRecord | CustomerCoreValues): value is CustomerCoreValues {
  return 'customerType' in value && 'documentType' in value
}

function hydrate(record?: CustomerCoreRecord | CustomerCoreValues): CustomerCoreValues {
  if (!record) return EMPTY_CUSTOMER_CORE
  return isCoreValues(record) ? record : customerCoreFromRecord(record)
}

export function useCustomerCore(options: UseCustomerCoreOptions = {}): UseCustomerCoreReturn {
  const { mode = 'create', initial } = options
  const canOfferWholesale = useWholesaleCustomerGate()

  const [draft, setDraft] = useState<CustomerCoreValues>(() => hydrate(initial))
  // La fila tal como se hidrató. Decide `preserved` y es la fuente de los
  // datos mayoristas que no se pueden editar. Un alta no tiene fila.
  const [stored, setStored] = useState<CustomerCoreValues | null>(() =>
    mode === 'update' && initial ? hydrate(initial) : null
  )
  const [touched, setTouched] = useState<TouchedFields>({})
  const [submitCount, setSubmitCount] = useState(0)

  const customerTypeAccess = resolveCustomerTypeAccess(canOfferWholesale, stored?.customerType ?? null)

  const values = useMemo(
    () => effectiveCustomerCoreValues(draft, customerTypeAccess, stored),
    [draft, customerTypeAccess, stored]
  )

  const setField = useCallback((field: CustomerCoreField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }))
  }, [])

  const setCustomerType = useCallback((customerType: CustomerType) => {
    // Sin gate no se elige tipo: `retail` es siempre minorista y `preserved`
    // conserva el mayorista guardado.
    if (customerTypeAccess !== 'full') return
    setDraft((previous) => applyCustomerType(previous, customerType))
  }, [customerTypeAccess])

  const markTouched = useCallback((field: CustomerCoreField) => {
    setTouched((previous) => (previous[field] ? previous : { ...previous, [field]: true }))
  }, [])

  const reset = useCallback((record?: CustomerCoreRecord) => {
    const next = hydrate(record)
    setDraft(next)
    setStored(mode === 'update' && record ? next : null)
    setTouched({})
    setSubmitCount(0)
  }, [mode])

  const errors = useMemo(
    () => validateCustomerCore(values, mode, customerTypeAccess),
    [values, mode, customerTypeAccess]
  )
  const errorMessage = useMemo(() => firstCustomerCoreError(errors), [errors])
  const isValid = Object.keys(errors).length === 0

  // `validateCustomerCore` dice qué está mal; esto sólo decide qué se muestra.
  const visibleErrors = useMemo(() => {
    if (submitCount > 0) return errors
    const shown: CustomerCoreErrors = {}
    for (const field of Object.keys(errors) as CustomerCoreField[]) {
      if (touched[field]) shown[field] = errors[field]
    }
    return shown
  }, [errors, touched, submitCount])

  const attemptSubmit = useCallback(() => {
    setSubmitCount((count) => count + 1)
    return isValid
  }, [isValid])

  const fieldProps = useMemo<CustomerCoreFieldProps>(() => ({
    values,
    errors: visibleErrors,
    customerTypeAccess,
    setField,
    setCustomerType,
    onFieldBlur: markTouched,
    submitCount,
  }), [values, visibleErrors, customerTypeAccess, setField, setCustomerType, markTouched, submitCount])

  return {
    values,
    errors,
    visibleErrors,
    isValid,
    errorMessage,
    customerTypeAccess,
    submitCount,
    setField,
    setCustomerType,
    markTouched,
    attemptSubmit,
    reset,
    toCreatePayload: useCallback(() => toCreatePayload(values, customerTypeAccess), [values, customerTypeAccess]),
    toUpdatePayload: useCallback(() => toUpdatePayload(values, customerTypeAccess), [values, customerTypeAccess]),
    fieldProps,
  }
}
