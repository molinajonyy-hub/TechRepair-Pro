/**
 * Estado compartido del formulario de cliente.
 *
 * Deliberadamente NO es un componente visual: las tres superficies se ven
 * distinto a propósito. Lo único que comparten es el estado y las reglas, y
 * eso es exactamente lo que vive acá.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  EMPTY_CUSTOMER_CORE,
  applyCustomerType,
  customerCoreFromRecord,
  firstCustomerCoreError,
  toCreatePayload,
  toUpdatePayload,
  validateCustomerCore,
  type CustomerCoreErrors,
  type CustomerCoreField,
  type CustomerCoreMode,
  type CustomerCoreRecord,
  type CustomerCoreValues,
  type CustomerCreatePayload,
  type CustomerType,
  type CustomerUpdatePayload,
} from './model'

export interface UseCustomerCoreOptions {
  mode?: CustomerCoreMode
  initial?: CustomerCoreRecord | CustomerCoreValues
}

export interface UseCustomerCoreReturn {
  values: CustomerCoreValues
  errors: CustomerCoreErrors
  isValid: boolean
  /** Primer error en orden de lectura del formulario, o ''. */
  errorMessage: string
  setField: (field: CustomerCoreField, value: string) => void
  setCustomerType: (customerType: CustomerType) => void
  reset: (record?: CustomerCoreRecord) => void
  toCreatePayload: () => CustomerCreatePayload
  toUpdatePayload: () => CustomerUpdatePayload
}

function isCoreValues(value: CustomerCoreRecord | CustomerCoreValues): value is CustomerCoreValues {
  return 'customerType' in value && 'documentType' in value
}

export function useCustomerCore(options: UseCustomerCoreOptions = {}): UseCustomerCoreReturn {
  const { mode = 'create', initial } = options

  const [values, setValues] = useState<CustomerCoreValues>(() => {
    if (!initial) return EMPTY_CUSTOMER_CORE
    return isCoreValues(initial) ? initial : customerCoreFromRecord(initial)
  })

  const setField = useCallback((field: CustomerCoreField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }))
  }, [])

  const setCustomerType = useCallback((customerType: CustomerType) => {
    setValues((previous) => applyCustomerType(previous, customerType))
  }, [])

  const reset = useCallback((record?: CustomerCoreRecord) => {
    setValues(record ? customerCoreFromRecord(record) : EMPTY_CUSTOMER_CORE)
  }, [])

  const errors = useMemo(() => validateCustomerCore(values, mode), [values, mode])
  const errorMessage = useMemo(() => firstCustomerCoreError(errors), [errors])

  return {
    values,
    errors,
    isValid: Object.keys(errors).length === 0,
    errorMessage,
    setField,
    setCustomerType,
    reset,
    toCreatePayload: useCallback(() => toCreatePayload(values), [values]),
    toUpdatePayload: useCallback(() => toUpdatePayload(values), [values]),
  }
}
