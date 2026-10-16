# CLIENTES-UX-1 — Edición de clientes + contacto alternativo para avisos

Dos PR independientes:

| Lote | Qué | Migraciones |
|---|---|---|
| **1A** (este documento, §1–§5) | Diagnóstico y corrección de la edición de clientes | No |
| **1B** (§6–§9, en su propio PR) | Contacto alternativo para avisos, destinatario por orden y WhatsApp | Sí, aditiva |

---

## 1. Diagnóstico de la edición (CLIENTES-UX-1A)

Pedido: «como owner, no puedo editar correctamente un cliente». No se asumió la
causa: se auditó el flujo completo y se reprodujo en un navegador real.

### 1.1 Qué se revisó

| Pieza | Resultado |
|---|---|
| `customersService.update` (`src/services/api.ts`) | `PATCH` filtrado por `id` + `business_id`, `.select().single()`. Correcto. |
| RLS `customers_update` | `business_id = current_user_business_id()` y rol en `owner/admin/manager/tech/sales/cashier`. El owner pasa. Es la misma lista que `customers_insert`, y las altas funcionan. |
| Trigger `trig_customers_wholesale_authority` (PRE-BETA-3A-2S) | Sólo rechaza cambios de tipo o de datos mayoristas sin acceso Mayorista. Un owner con plan Full lo pasa; una edición de datos comunes ni lo dispara. |
| `update_customers_updated_at`, constraints | Sin restricciones que bloqueen una edición (sólo `name`/`phone` NOT NULL, y `phone` acepta `''`). |
| `useCustomerCore` / `validateCustomerCore` | **Bloqueo en el cliente** para un caso (ver 1.3, causa 2). |
| `Customers.tsx` (listado) | Edición desde la tabla (lápiz) y desde el menú de la tarjeta en celular. Funciona; sin confirmación. |
| `CustomerDetail.tsx` (ficha) | **No tiene ninguna forma de editar.** |

### 1.2 Evidencia

- **Logs de producción (sólo lectura, sólo método/estado/ruta, sin datos de
  clientes), 11 al 16 de octubre**:
  - no hay **ningún** `PATCH /rest/v1/customers`;
  - en la misma ventana sí aparecen `POST /rest/v1/customers` con `201` (altas que funcionan) y `PATCH` a otras tablas.

  Es decir, los intentos de edición **nunca llegaron al servidor**: no hay
  errores de RLS ni de permisos que explicar. El bloqueo está antes, en el
  navegador. (Una consulta más amplia a producción quedó bloqueada por la
  política de la sesión; no se insistió.)
- **Reproducción local** contra el Supabase simulado, en Chromium, a 1440 y
  390 px. El simulador es `evidence/serve-stateful.mjs`; guarda en memoria y
  agrega un mayorista del portal.

  | Caso | Resultado |
  |---|---|
  | Listado → editar un minorista → guardar | Se envía el `PATCH`; al reabrir se ven los datos nuevos. **Sin ninguna confirmación.** |
  | Ficha → editar | **0 controles de edición.** |
  | Listado → mayorista creado por el portal (sin razón social) → cambiar sólo el teléfono | **No se envía nada**: el foco salta a «Razón social» con «Un cliente mayorista necesita razón social.». Un usuario *sin* acceso a Mayorista guarda la misma edición sin problema. |
  | Ficha en celular | La grilla fija `260px 1fr` deja las pestañas cortadas fuera de la pantalla. |

- El E2E existente `customer-core-parity.spec.ts` (base real) ya probaba editar
  un minorista desde la tabla de escritorio, y pasaba: ese camino no estaba roto.

### 1.3 Causa raíz

No hay una sola causa. Los cuatro problemas que hacen que el owner «no pueda
editar correctamente» son reproducibles y están en el frontend:

1. **La ficha individual no permite editar.** Desde el detalle del cliente no
   hay botón, menú ni ruta de edición.
2. **Regla de mayorista invertida para el owner.** `validateCustomerCore` exige
   razón social a todo mayorista cuando el actor tiene acceso Mayorista
   (`full`). Pero los mayoristas que crea el portal
   (`get_or_create_customer_from_wholesale_atomic`) pueden no tener razón
   social: el owner no podía ni corregirles el teléfono, mientras que alguien
   sin acceso (`preserved`) sí podía. Es un caso específico de mayoristas
   históricos, no de todos los clientes.
3. **No había confirmación ni forma de comprobar lo guardado.** El diálogo se
   cerraba sin aviso, y la ficha no mostraba documento, notas ni datos
   mayoristas: al «reabrir el registro» no había dónde verlos.
4. **Errores crudos del servidor.** Por ejemplo:
   - «JSON object requested, multiple (or no) rows returned» cuando la RLS no
     deja tocar la fila;
   - «WHOLESALE_AUTHORITY_REQUIRED: …»;
   - «Revisá las políticas de customers», una instrucción para el desarrollador.

**Lo que no es causa**: RLS, permisos del owner, trigger de autoridad Mayorista,
`business_id`, constraints. No hubo ningún rechazo del servidor que explicar.

## 2. Cambios (1A)

- **`CustomerEditDialog`** (`src/features/customer-core/`): la edición pasa a ser
  un único diálogo para el listado y la ficha. Usa:
  - el mismo cuerpo que las altas (`CustomerCreateFields`);
  - las mismas reglas (`useCustomerCore`);
  - el mismo guardado (`customersService.update`).

  Se monta con `key` por cliente, así se hidrata en el primer render. Hay un
  bloqueo de doble envío, que se libera si el servidor rechaza el guardado.
- **Ficha**:
  - Botón **«Editar cliente»** en el encabezado.
  - Al guardar, la ficha se actualiza con la fila devuelta, sin recargar, y
    aparece «Cambios guardados.».
  - La tarjeta Contacto muestra documento, notas y, si es mayorista, razón
    social y contacto.
  - En celular, ficha y pestañas se apilan.
- **Listado**: tras guardar, «Cambios guardados en <cliente>.» y la lista se recarga.
- **Regla de mayorista** (`validateCustomerCore(values, mode, access, stored)`):
  - en edición, un mayorista que **ya** no tenía razón social se puede guardar sin inventarla;
  - convertir a mayorista sigue exigiendo razón social;
  - borrar una razón social guardada sigue bloqueado;
  - un alta mayorista sigue exigiéndola siempre.
- **Errores** (`getCustomerErrorMessage`): mensajes para quien usa la pantalla.

  | Caso | Mensaje |
  |---|---|
  | `PGRST116` | «el cliente ya no existe o no tenés permiso para editarlo» |
  | `42501` / RLS | «No tenés permiso para editar clientes…» |
  | Autoridad Mayorista | «Cambiar el tipo… requiere acceso a Mayorista» |
  | `23502` / `23514` | Faltan datos o hay un formato inválido |
  | Sin conexión | Mensaje de reconexión |
  | Mensaje ya legible | Pasa tal cual |
- **Confirmación** (`useSavedNotice` + `SavedNotice`): la región
  `role="status"` existe siempre; el aviso dura 6 s. En tema claro usa
  `--success-soft` (AA).

**Sin cambios**:
- Migraciones, RLS, triggers, permisos, rutas.
- Altas (página completa y rápida desde Nueva Orden).
- Mayorista (gate, `preserved`, trigger).
- Órdenes, comprobantes, cuentas corrientes, garantías, historial.
- Finanzas.

## 3. Tests (1A)

- **`tests/components/clientesUx1aEdit.test.tsx`** (16 tests):
  - A · ficha: botón, hidratación, guardar → confirma y muestra lo guardado, error legible con reintento, cancelar, datos mayoristas.
  - B · listado: confirmación con nombre y recarga.
  - C · mayorista del portal: el owner guarda sin inventar razón social, cargarla también guarda, y la regla pura del core.
  - D · mapeo de errores.
- **`tests/e2e/m7/clientes-ux-1a-edit.spec.ts`** (6 tests, base real en CI):
  - escritorio (ficha, listado, mayorista del portal, razón social que no se puede borrar);
  - celular (ficha y menú de la tarjeta);
  - cada uno lee la fila con SQL y recarga o reabre para comprobar persistencia.
- **CI**: paso `CLIENTES-UX-1A` (`npm run test:clientes-ux-1a`), que corre los tests nuevos y los de clientes que ya existían.

## 4. Evidencia

- `evidence/01-ficha-editar-cliente.png` — ficha antes/después, escritorio y celular.
- `evidence/02-listado-y-mayorista.png` — confirmación del listado y mayorista del portal.
- Reproducir:
  1. `node docs/clientes-ux-1/evidence/serve-stateful.mjs`
  2. `node docs/clientes-ux-1/evidence/capture-1a.mjs . <before|after> <dir>`
  3. `node docs/clientes-ux-1/evidence/contact-sheet.mjs . <dir> docs/clientes-ux-1/evidence`

## 5. Riesgos pendientes (1A)

- La causa exacta que vio el owner en producción no se pudo atar a un request:
  no hubo ningún intento de edición que llegara al servidor en los logs
  disponibles. Se corrigieron las cuatro causas reproducibles. Si el problema
  persiste, hace falta el caso concreto (cliente y pantalla) para reproducirlo.
- Los botones del encabezado de la ficha miden 34 px en celular, igual que
  «Volver» y «WhatsApp» que ya estaban. Pasarlos a 44 px es un cambio de todo
  el encabezado, fuera de este lote.

---

## 6. Contacto alternativo y destinatario por orden (CLIENTES-UX-1B)

### 6.1 Discovery del esquema

| Pieza | Hallazgo | Consecuencia |
|---|---|---|
| `customers.contact_person` | Es el contacto **mayorista**; lo protege `trig_customers_wholesale_authority` (`UPDATE OF customer_type, business_name, contact_person, business_id`). | No se reutiliza. Columnas nuevas, fuera del trigger. |
| `customers` grants/RLS | GRANT de tabla a `authenticated`; RLS por tenant + rol. | Las columnas nuevas se editan igual que el resto del cliente. |
| `orders` | SEC-08A: SELECT **por columna** (lista cerrada), UPDATE sólo con `orders_change_status`, `create_order_intake` con idempotencia por hash. | No se toca `orders` ni la RPC de recepción: el destinatario vive en una tabla aparte. |
| WhatsApp | `OrderDetail` y `handleAutoSend` usaban `order.customer.phone`; el preview ya permitía corregir el número. | Pasan a usar el destinatario resuelto. |
| Garantías, comprobantes, cuentas corrientes | Leen `orders.customer_id` y los datos del cliente. | **Sin cambios**: la titularidad no se mueve. |

### 6.2 Migración `20261015180000_clientes_ux_1b_notification_contact.sql` (aditiva)

**Versión.** `20261015180000` queda entre `20261015120000`, la última versión productiva reportada, y `20261016120000`.

- `20261016120000` es la migración candidata de BETA-MP (email), que su runbook y `tests/unit/billingContracts.test.ts` exigen aplicar **al final**.
- Las dos son independientes: no comparten objetos.
- Si la de BETA-MP ya se aplicó en producción cuando se libere este lote, hay que aplicar esta igual (es aditiva); no se repara historial.


- **`customers.notification_contact_name` y `notification_contact_phone`** (opcionales):
  - van de a dos: los dos o ninguno;
  - nombre de hasta 120 caracteres;
  - teléfono con dígitos, `+`, espacios, guiones o paréntesis, de 8 a 15 dígitos.

  No hay backfill: ningún teléfono existente se modifica.
- **`order_notification_recipients`** (`order_id` PK):
  - `recipient` es `customer` o `alternate`;
  - con `alternate`, guarda una **copia** del nombre y el teléfono.

  Lectura con RLS (tenant + capacidad `orders`), sin escritura directa. Sin fila, se avisa al titular: todas las órdenes existentes siguen igual.
- **`set_order_notification_recipient(order, kind)`**:
  - es la única escritura; SECURITY DEFINER con `search_path = pg_catalog, pg_temp`, `REVOKE` a PUBLIC y anon;
  - la autoridad es el negocio del actor más `orders_create` (recepción) u `orders_change_status` (seguimiento);
  - es idempotente; sin contacto cargado responde `ALTERNATE_CONTACT_MISSING`.
- **Postcondiciones** dentro de la migración:
  - columnas creadas y 0 filas tocadas;
  - RLS activa;
  - grants según el contrato;
  - RPC endurecida;
  - el trigger mayorista no mira las columnas nuevas.

### 6.3 Decisión: copia sólo para el contacto alternativo

- **Titular (`customer`)**: no se copia nada. Si el cliente corrige su teléfono (por ejemplo con la edición de 1A), sus órdenes abiertas avisan al número corregido.
- **Contacto alternativo (`alternate`)**: se copia al elegirlo. Es una persona designada para *esta* reparación. Si después la ficha cambia o borra el contacto, la orden sigue avisando a quien se eligió.
- **Si la copia ya no coincide con la ficha**, la orden lo dice y ofrece «Usar el de la ficha». Nunca se actualiza sola.

### 6.4 Pantallas

- **Formulario compartido**: sección «Contacto para avisos (opcional)» con nombre y teléfono. Aparece en:
  - alta;
  - edición;
  - alta rápida desde Nueva orden.

  Valida igual que la base, y además el número tiene que poder normalizarse para WhatsApp. No puede ser el mismo teléfono principal.
- **Ficha**: «Contacto para avisos: …» en la tarjeta Contacto.
- **Nueva orden**: si el cliente tiene contacto, aparece «¿A quién avisamos por WhatsApp?»:
  - por defecto, el cliente;
  - la elección queda en el resumen;
  - se guarda después de crear la orden; si falla, la orden se crea igual y el detalle lo avisa.
- **Detalle de la orden**: «Avisos por WhatsApp» en la tarjeta Cliente:
  - muestra rol, nombre y número;
  - se puede elegir Cliente o Contacto alternativo;
  - si no hay contacto, indica dónde cargarlo.
- **WhatsApp**:
  - el preview propone el destinatario: «Para María Hija · Contacto alternativo» y el número usado. Se sigue pudiendo editar el número y el mensaje antes de abrir WhatsApp.
  - `{nombre}` saluda a quien recibe; `{cliente}` y `{apellido}` siguen siendo del titular.
  - el envío automático existente (sólo con Cloud API conectada) usa el mismo destinatario. No se agrega ningún envío nuevo.
- **Secretos de desbloqueo**: las variables de la orden no incluyen acceso, PIN ni patrón. Hay un test que lo verifica.

### 6.5 Compatibilidad y despliegue

El frontend se despliega al mergear y la migración se aplica a mano. Por eso, **sin la migración aplicada todo sigue funcionando**:

- Los payloads del cliente sólo nombran las columnas nuevas si hay algo que escribir o que borrar.
- Lecturas:
  - cliente con `select('*')`;
  - la tabla de destinatarios es tolerante: si falta, se avisa al titular;
  - la RPC ausente muestra un mensaje claro.
- Si alguien intenta guardar un contacto sin migración, ve «falta actualizar la base de datos».

Orden recomendado: **aplicar la migración y después mergear**. No se hizo `db push`.

## 7. Tests (1B)

- **`tests/sql/clientes_ux_1b.test.sql`** (27 aserciones), en el job E2E sobre la base real (`npm run test:sql:clientes-ux-1b`):
  - CHECK de a dos y de formato;
  - grants y RLS;
  - sin escritura directa;
  - RPC: alternativo sin contacto, valor inválido, copia, la copia sobrevive a cambios y borrado de la ficha, titular sin copia, idempotencia;
  - teléfono principal y titularidad intactos;
  - aislamiento entre negocios;
  - técnico sin capacidad;
  - contacto de un mayorista editable sin acceso Mayorista.

  Validado también contra Postgres 16 local con un esqueleto de Supabase.
- **`tests/components/clientesUx1bNoticeContact.test.tsx`** (23 tests):
  - reglas del core y payloads, incluida una base sin migrar;
  - formulario de alta y edición;
  - resolución del destinatario;
  - panel de la orden;
  - recepción;
  - WhatsApp: saludo, sin secretos, envío automático al destinatario.
- **`tests/e2e/m7/clientes-ux-1b-notice.spec.ts`**:
  - escritorio: ficha → recepción → orden → preview → la ficha cambia → volver al titular, todo leído con SQL; y recepción sin contacto;
  - celular: alta rápida con contacto.
- **Actualizados**:
  - `customerCreateFields`: la jerarquía suma la sección nueva;
  - `betaUx1dOrderDetail` y `orderDetailHistory`: mock de `usePermissions`, la nueva dependencia del detalle.
- **CI**: paso `CLIENTES-UX-1B` (`npm run test:clientes-ux-1b`) y paso SQL en el job E2E.

## 8. Evidencia (1B)

- `evidence/03-contacto-para-avisos.png` — editar cliente antes/después y ficha.
- `evidence/04-recepcion-destinatario.png` — elección en la recepción (1440 y 390) y resumen.
- `evidence/05-orden-y-whatsapp.png` — tarjeta Cliente y preview de WhatsApp antes/después.
- Reproducir: `serve-stateful.mjs` (con `MOCK_NO_1B=1` simula una base sin migrar) y `capture-1b.mjs`, y después `contact-sheet.mjs … 1b`.

## 9. Riesgos pendientes (1B)

- **Orden de despliegue**: hay que aplicar la migración antes de usar la función. Sin ella el producto se comporta como antes, pero no se puede cargar el contacto.
- **Versión de la migración**: va antes de la candidata de BETA-MP (ver §6.2). Hay que confirmar el estado del ledger productivo al liberar.
- **`{whatsapp}` y `{telefono}` se reemplazan entre sí** (regla previa de W1, en `resolveWhatsAppValues` y en `whatsappFormat`). Son teléfonos de personas distintas: «WhatsApp del negocio» y «Teléfono del cliente».
  - El preview de una orden no carga `{telefono}`, así que una plantilla que lo use muestra el WhatsApp del negocio.
  - Donde sí se carga el teléfono del cliente y el negocio no configuró su WhatsApp, `{whatsapp}` muestra el del cliente.

  Ya pasaba antes de este lote y no lo cambié: queda como tarea aparte.
- **El destinatario se guarda después de crear la orden** (no en la misma transacción que `create_order_intake`, que no se tocó). Si esa llamada falla, la orden queda avisando al titular y el detalle lo indica.
