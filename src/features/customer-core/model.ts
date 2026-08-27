/**
 * Customer core — semántica única de alta y edición de clientes.
 *
 * Este módulo NO dibuja nada. Existe porque las tres superficies que escriben
 * clientes (alta full page, alta rápida desde Nueva Orden, y edición desde la
 * lista) tenían reglas distintas para los mismos datos:
 *
 *  - el documento se guardaba en dos formatos incompatibles;
 *  - la regla "mayorista exige razón social" se validaba en JS en una,
 *    con `required` de HTML en otra, y en ninguna en la edición;
 *  - la edición podía dejar un mayorista SIN razón social;
 *  - volver de mayorista a minorista limpiaba los campos en el formulario
 *    pero no en la fila, así que quedaba una razón social huérfana.
 *
 * La presentación sigue siendo específica de cada contexto — full page,
 * diálogo y POS pueden verse distinto. Lo que no puede diferir es esto.
 *
 * @see ./document.ts para la decisión de formato del documento.
 */

import {
  defaultDocumentTypeFor,
  normalizeDocumentInput,
  parseStoredDocument,
  type DocumentType,
} from './document'

/**
 * Valores del dominio. `minorista` / `mayorista` NO son etiquetas de UI: son
 * exactamente lo que acepta el CHECK `customers_customer_type_check`.
 */
export type CustomerType = 'minorista' | 'mayorista'

export const CUSTOMER_TYPES: readonly CustomerType[] = ['minorista', 'mayorista'] as const

/** Estado editable canónico. Superset de lo que cualquier pantalla muestra. */
export interface CustomerCoreValues {
  name: string
  phone: string
  email: string
  address: string
  notes: string
  documentType: DocumentType
  document: string
  customerType: CustomerType
  businessName: string
  contactPerson: string
}

export const EMPTY_CUSTOMER_CORE: CustomerCoreValues = {
  name: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  documentType: 'dni',
  document: '',
  customerType: 'minorista',
  businessName: '',
  contactPerson: '',
}

export type CustomerCoreField = keyof CustomerCoreValues

export type CustomerCoreErrors = Partial<Record<CustomerCoreField, string>>

/**
 * `create` y `update` no exigen lo mismo, y es deliberado.
 *
 * Las dos altas ya pedían teléfono; la edición nunca lo pidió. Exigirlo al
 * editar rompería a cualquier cliente histórico cargado sin teléfono (la
 * columna es NOT NULL pero acepta ''). El lote canoniza la regla de mayorista,
 * que es la que estaba rota, sin volver ineditable data que hoy se edita bien.
 */
export type CustomerCoreMode = 'create' | 'update'

/** Payload de alta. Las claves son las columnas reales de `customers`. */
export interface CustomerCreatePayload {
  name: string
  phone: string
  email?: string
  address?: string
  notes?: string
  document?: string
  customer_type: CustomerType
  business_name?: string
  contact_person?: string
}

/**
 * Payload de edición.
 *
 * Acepta `null` a propósito: al pasar de mayorista a minorista hay que BORRAR
 * la razón social en la fila, no sólo en el formulario. `undefined` no alcanza
 * — PostgREST omite la clave y el valor viejo sobrevive.
 */
export interface CustomerUpdatePayload {
  name: string
  phone: string
  email: string | null
  address: string | null
  notes: string | null
  document: string | null
  customer_type: CustomerType
  business_name: string | null
  contact_person: string | null
}

/** Fila (o proyección de fila) desde la que se hidrata el formulario de edición. */
export interface CustomerCoreRecord {
  name?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  notes?: string | null
  document?: string | null
  customer_type?: string | null
  business_name?: string | null
  contact_person?: string | null
}

const text = (value: string | null | undefined): string => (value ?? '').trim()

const orUndefined = (value: string): string | undefined => value || undefined

const orNull = (value: string): string | null => value || null

/** Normaliza cualquier string a un `CustomerType` válido para el CHECK de la DB. */
export function toCustomerType(value: string | null | undefined): CustomerType {
  return value === 'mayorista' ? 'mayorista' : 'minorista'
}

/**
 * Hidrata el estado editable desde una fila existente.
 *
 * El tipo de documento sale del propio valor guardado cuando la fila lo
 * declara; si no lo declara (filas viejas, import de Excel), cae al default
 * del tipo de cliente en vez de asumir DNI siempre.
 */
export function customerCoreFromRecord(record: CustomerCoreRecord): CustomerCoreValues {
  const customerType = toCustomerType(record.customer_type)
  const parsed = parseStoredDocument(record.document)

  return {
    name: text(record.name),
    phone: text(record.phone),
    email: text(record.email),
    address: text(record.address),
    notes: text(record.notes),
    documentType: parsed.type ?? defaultDocumentTypeFor(customerType),
    document: parsed.body,
    customerType,
    businessName: text(record.business_name),
    contactPerson: text(record.contact_person),
  }
}

/**
 * Cambio de tipo de cliente, con la limpieza canónica.
 *
 * Volver a minorista descarta razón social y persona de contacto — que es lo
 * que las dos altas ya hacían por su cuenta. Además arrastra el tipo de
 * documento al default del nuevo tipo, para que un mayorista quede en CUIT y
 * un minorista en DNI sin que el usuario tenga que acordarse.
 */
export function applyCustomerType(
  values: CustomerCoreValues,
  customerType: CustomerType
): CustomerCoreValues {
  if (customerType === values.customerType) return values

  return {
    ...values,
    customerType,
    documentType: defaultDocumentTypeFor(customerType),
    businessName: customerType === 'minorista' ? '' : values.businessName,
    contactPerson: customerType === 'minorista' ? '' : values.contactPerson,
  }
}

/**
 * Validación canónica.
 *
 * El documento se normaliza pero NO se rechaza por longitud: hoy las tres
 * pantallas aceptan cualquier cosa, y endurecerlo acá bloquearía altas que
 * hoy funcionan (pasaportes, documentos extranjeros). Endurecerlo es una
 * decisión de producto, no un efecto colateral de este lote.
 */
export function validateCustomerCore(
  values: CustomerCoreValues,
  mode: CustomerCoreMode = 'create'
): CustomerCoreErrors {
  const errors: CustomerCoreErrors = {}

  if (!text(values.name)) {
    errors.name = 'El nombre es obligatorio.'
  }

  if (mode === 'create' && !text(values.phone)) {
    errors.phone = 'El teléfono es obligatorio.'
  }

  if (values.customerType === 'mayorista' && !text(values.businessName)) {
    errors.businessName = 'Un cliente mayorista necesita razón social.'
  }

  return errors
}

export function isCustomerCoreValid(
  values: CustomerCoreValues,
  mode: CustomerCoreMode = 'create'
): boolean {
  return Object.keys(validateCustomerCore(values, mode)).length === 0
}

/** Primer mensaje de error, para las superficies que muestran un único aviso. */
export function firstCustomerCoreError(errors: CustomerCoreErrors): string {
  const order: CustomerCoreField[] = ['name', 'phone', 'businessName', 'contactPerson', 'document']
  for (const field of order) {
    const message = errors[field]
    if (message) return message
  }
  return Object.values(errors)[0] ?? ''
}

/**
 * Campos que sólo tienen sentido en un mayorista.
 * Un minorista los descarta, sin importar qué haya quedado en el formulario.
 */
function wholesaleFields(values: CustomerCoreValues) {
  const wholesale = values.customerType === 'mayorista'
  return {
    businessName: wholesale ? text(values.businessName) : '',
    contactPerson: wholesale ? text(values.contactPerson) : '',
  }
}

export function toCreatePayload(values: CustomerCoreValues): CustomerCreatePayload {
  const { businessName, contactPerson } = wholesaleFields(values)

  return {
    name: text(values.name),
    phone: text(values.phone),
    email: orUndefined(text(values.email)),
    address: orUndefined(text(values.address)),
    notes: orUndefined(text(values.notes)),
    document: normalizeDocumentInput(values.documentType, values.document),
    customer_type: values.customerType,
    business_name: orUndefined(businessName),
    contact_person: orUndefined(contactPerson),
  }
}

export function toUpdatePayload(values: CustomerCoreValues): CustomerUpdatePayload {
  const { businessName, contactPerson } = wholesaleFields(values)

  return {
    name: text(values.name),
    phone: text(values.phone),
    email: orNull(text(values.email)),
    address: orNull(text(values.address)),
    notes: orNull(text(values.notes)),
    document: normalizeDocumentInput(values.documentType, values.document) ?? null,
    customer_type: values.customerType,
    business_name: orNull(businessName),
    contact_person: orNull(contactPerson),
  }
}
