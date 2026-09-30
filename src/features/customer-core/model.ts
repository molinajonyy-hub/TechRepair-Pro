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

/**
 * PRE-BETA-3A-2 — Qué puede hacer el actor con el TIPO de cliente.
 *
 * El gate Mayorista (feature `mayorista` del negocio Y permiso `wholesale` del
 * actor) decide si se OFRECE mayorista. Lo que ya existe no se toca:
 *
 *  - `full`      → gate activo: minorista o mayorista, como siempre.
 *  - `retail`    → sin gate. Un alta nueva, o una fila minorista, sólo puede
 *                  ser minorista. Ningún estado viejo del formulario puede
 *                  terminar escribiendo `customer_type: 'mayorista'`.
 *  - `preserved` → sin gate, pero la fila YA es mayorista. Se conserva tal
 *                  cual: la edición no escribe tipo ni datos mayoristas, así
 *                  que ni se convierte a minorista ni se borra la razón social.
 */
export type CustomerTypeAccess = 'full' | 'retail' | 'preserved'

/**
 * Resuelve el acceso a partir del gate y del tipo GUARDADO (no el del
 * formulario). Un alta no tiene tipo guardado: sin gate es `retail`.
 */
export function resolveCustomerTypeAccess(
  canOfferWholesale: boolean,
  storedType: CustomerType | null
): CustomerTypeAccess {
  if (canOfferWholesale) return 'full'
  return storedType === 'mayorista' ? 'preserved' : 'retail'
}

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
 * Lo que TODA edición escribe, tenga o no el gate Mayorista.
 */
export interface CustomerCommonUpdatePayload {
  name: string
  phone: string
  email: string | null
  address: string | null
  notes: string | null
  document: string | null
}

/**
 * Payload de edición que además decide el tipo (acceso `full` o `retail`).
 *
 * Acepta `null` a propósito: al pasar de mayorista a minorista hay que BORRAR
 * la razón social en la fila, no sólo en el formulario. `undefined` no alcanza
 * — PostgREST omite la clave y el valor viejo sobrevive.
 */
export interface CustomerUpdatePayload extends CustomerCommonUpdatePayload {
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
 * PRE-BETA-3A-2 — Valores efectivos bajo un acceso: lo que se muestra es lo
 * que se escribe.
 *
 *  - `retail`: nunca mayorista. Si el formulario quedó en mayorista (el gate se
 *    cayó con el formulario abierto), se lo lleva a minorista acá, que es de
 *    donde salen la vista, la validación y el payload. El tipo de documento
 *    que eligió el usuario se respeta: un CUIT ya tipeado no pasa a ser DNI.
 *  - `preserved`: siempre mayorista, con la razón social y el contacto
 *    GUARDADOS (`stored`), no los del formulario, porque no son editables.
 */
export function effectiveCustomerCoreValues(
  values: CustomerCoreValues,
  access: CustomerTypeAccess,
  stored?: Pick<CustomerCoreValues, 'businessName' | 'contactPerson'> | null
): CustomerCoreValues {
  if (access === 'retail') {
    if (values.customerType === 'minorista') return values
    return { ...values, customerType: 'minorista', businessName: '', contactPerson: '' }
  }
  if (access === 'preserved') {
    return {
      ...values,
      customerType: 'mayorista',
      businessName: stored?.businessName ?? values.businessName,
      contactPerson: stored?.contactPerson ?? values.contactPerson,
    }
  }
  return values
}

/**
 * Validación canónica.
 *
 * El documento se normaliza pero NO se rechaza por longitud: hoy las tres
 * pantallas aceptan cualquier cosa, y endurecerlo acá bloquearía altas que
 * hoy funcionan (pasaportes, documentos extranjeros). Endurecerlo es una
 * decisión de producto, no un efecto colateral de este lote.
 *
 * `access` sólo importa en `preserved`: esa edición no escribe tipo ni razón
 * social (ver `toUpdatePayload`), así que la regla de mayorista no tiene nada
 * que validar. Un mayorista histórico sin razón social —p. ej. los que crea el
 * portal— sigue siendo editable en sus datos comunes sin que nadie sin acceso
 * a Mayorista tenga que inventarle una.
 */
export function validateCustomerCore(
  values: CustomerCoreValues,
  mode: CustomerCoreMode = 'create',
  access: CustomerTypeAccess = 'full'
): CustomerCoreErrors {
  const errors: CustomerCoreErrors = {}

  if (!text(values.name)) {
    errors.name = 'El nombre es obligatorio.'
  }

  if (mode === 'create' && !text(values.phone)) {
    errors.phone = 'El teléfono es obligatorio.'
  }

  if (mode === 'create' && text(values.email) && !EMAIL_PATTERN.test(text(values.email))) {
    errors.email = 'Ingresá un email válido.'
  }

  if (access !== 'preserved' && values.customerType === 'mayorista' && !text(values.businessName)) {
    errors.businessName = 'Un cliente mayorista necesita razón social.'
  }

  return errors
}

export function isCustomerCoreValid(
  values: CustomerCoreValues,
  mode: CustomerCoreMode = 'create',
  access: CustomerTypeAccess = 'full'
): boolean {
  return Object.keys(validateCustomerCore(values, mode, access)).length === 0
}

/** Primer mensaje de error, para las superficies que muestran un único aviso. */
export function firstCustomerCoreError(errors: CustomerCoreErrors): string {
  const order: CustomerCoreField[] = ['name', 'phone', 'email', 'businessName', 'contactPerson', 'document']
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

/**
 * `access` es obligatorio a propósito: no hay un default seguro. Un alta sin
 * gate Mayorista es SIEMPRE minorista, aunque el estado del formulario diga
 * otra cosa — ocultar el botón no alcanza, el payload también lo garantiza.
 */
export function toCreatePayload(values: CustomerCoreValues, access: CustomerTypeAccess): CustomerCreatePayload {
  const effective = access === 'full' ? values : effectiveCustomerCoreValues(values, 'retail')
  const { businessName, contactPerson } = wholesaleFields(effective)

  return {
    name: text(effective.name),
    phone: text(effective.phone),
    email: orUndefined(text(effective.email)),
    address: orUndefined(text(effective.address)),
    notes: orUndefined(text(effective.notes)),
    document: normalizeDocumentInput(effective.documentType, effective.document),
    customer_type: effective.customerType,
    business_name: orUndefined(businessName),
    contact_person: orUndefined(contactPerson),
  }
}

/**
 * `access` es obligatorio: en una edición el default "seguro" depende de la
 * fila. Suponer `retail` convertiría a minorista un mayorista existente, y
 * suponer `full` dejaría escribir mayorista sin gate.
 */
export function toUpdatePayload(values: CustomerCoreValues, access: 'full' | 'retail'): CustomerUpdatePayload
export function toUpdatePayload(
  values: CustomerCoreValues,
  access: CustomerTypeAccess
): CustomerUpdatePayload | CustomerCommonUpdatePayload
export function toUpdatePayload(
  values: CustomerCoreValues,
  access: CustomerTypeAccess
): CustomerUpdatePayload | CustomerCommonUpdatePayload {
  const common: CustomerCommonUpdatePayload = {
    name: text(values.name),
    phone: text(values.phone),
    email: orNull(text(values.email)),
    address: orNull(text(values.address)),
    notes: orNull(text(values.notes)),
    document: normalizeDocumentInput(values.documentType, values.document) ?? null,
  }

  // PRE-BETA-3A-2 — mayorista existente sin gate: el PATCH ni siquiera nombra
  // tipo, razón social ni contacto. Lo guardado sobrevive por construcción,
  // aunque el formulario se haya hidratado de una fila vieja.
  if (access === 'preserved') return common

  const effective = effectiveCustomerCoreValues(values, access)
  const { businessName, contactPerson } = wholesaleFields(effective)

  return {
    ...common,
    customer_type: effective.customerType,
    business_name: orNull(businessName),
    contact_person: orNull(contactPerson),
  }
}
