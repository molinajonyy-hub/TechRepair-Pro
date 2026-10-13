# BETA-MP-RECOVERY — revisión, despliegue y certificación pendiente

Referencia: auditoría de producción del 13/10/2026, `main`
`a0b1e63fb7539cca809fbce1c77da89c8b980e81`. Trabajo en
`codex/beta-mp-recovery`. Este documento reemplaza las conclusiones de recuperación,
activación y reemplazo del runbook anterior para este candidato.

**Estado: candidato para revisión; BETA-MP no está certificado comercialmente.**
En este trabajo no se ejecutaron operaciones sobre producción: ni consultas nuevas,
migraciones remotas, despliegues, cobros, cancelaciones ni cambios de datos comerciales.
La evidencia productiva siguiente procede de la auditoría anterior. Las nuevas pruebas
usan Mercado Pago simulado, incluso cuando PostgreSQL/PostgREST son reales.

## Decisión comercial confirmada

El owner decidió: **activar sólo después del primer pago efectivamente `approved`**.
`authorized` significa que la suscripción está autorizada; no acredita una cuota cobrada.
La primera activación exige una suscripción autorizada, su sesión emitida por el servidor,
una factura vinculada y el pago real aprobado, con importe, moneda y fecha de aprobación
válidos. La sesión se consume sólo después de persistir esa evidencia.

Una etiqueta histórica `paid`, una URL de retorno, `invoice.status = processed`,
el email del pagador o `last_payment_status` aislado no prueban un pago.
El backend entrega `payment_confirmed` desde el ledger; las pantallas de espera y éxito
exigen esa prueba. Se conserva el acceso previo mientras espera la primera cuota.
Se conserva también la regla existente de que gana la intención pagada más nueva
(creación de la sesión, con ID como desempate), ahora con prueba del pago real.
Un cobro tardío de una intención anterior no reemplaza una compra más nueva aprobada.
No se extienden trials ni se conceden accesos manuales para compensar automáticamente.

## Diagnóstico por fase

| Fase | Evidencia y corrección | Pendiente para producción |
|---|---|---|
| 1 — webhook P0 | Se centralizó HMAC-SHA256 con verificación criptográfica, ID de la URL, normalización alfanumérica, omisión de componentes ausentes y timestamp literal. Se rechazan parámetros duplicados y contradicciones URL/cuerpo. | El 401 real todavía requiere una captura privada y correspondencia aplicación/secreto; las variantes corregidas no demuestran la causa de los requests auditados. |
| 2 — ledger | Reconcile enumera facturas de la suscripción conocida y relee factura/pago por ID. Verifica pertenencia, estado real, importe y moneda antes de escribir. Deduplica por factura y también por pago real. | Aplicar la nueva restricción sólo con autorización; verificar ledger real durante el smoke. |
| 3 — activación | Regla aprobada por el owner, aplicada en el camino canónico, respuestas, interfaz y pruebas. Un pago pendiente no activa. | Primer cobro aprobado del negocio QA. |
| 4 — cambio de plan | La cancelación anterior exige GET → PUT si hace falta → GET que confirme cancelado. Si falla, se conserva el plan anterior y la nueva sesión queda pendiente. Reintentos reparan cortes parciales sin duplicar el evento ni repetir una cancelación ya confirmada. | Prueba real separada y autorizada. Puede haber dos contratos cobrando durante el fallo; el evento pendiente debe atenderse. |
| 5 — Plan A antiguo | Se conserva sin asociación heurística ni reparación financiera. Estado actual de MP no comprobado. | Revisión privada y decisión comercial del owner. |
| 6 — certificación | Procedimiento y matriz de evidencias definidos abajo. | Smoke real y revisión de resultados; simulaciones no certifican MP. |

## P0: qué demuestra y qué no demuestra el código

La auditoría identificó requests por el User-Agent
`MercadoPago WebHook v1.0 subscription_preapproval`: uno del 12/10 a las 23:50:26
y otro del 13/10 a las 03:15:57, hora argentina. Ambos respondieron HTTP 401 con
`invalid signature`. Los logs confirmaban presencia de `x-signature`,
`x-request-id` y `data.id` en URL. El segundo ID correspondía a una sesión Plan B
conocida; el primero no tenía vínculo local.

Esos requests **no quedaron autenticados criptográficamente**. El ID auditado ya era
alfanumérico en minúsculas y los tres componentes estaban presentes: el manifiesto
anterior en ese caso coincide con la receta oficial. Por tanto, la omisión de campos
y la eliminación del fallback al cuerpo corrigen variantes y un límite de seguridad,
pero **no permiten afirmar que el 401 productivo quedó resuelto**, ni que el secreto
estaba mal.

La URL se interpreta con `URLSearchParams`: se decodifica una vez el valor de
`data.id`; no se firma la URL completa ni su orden de parámetros. El ID alfanumérico
se lleva a minúsculas. Se preservan `x-request-id` y `ts`; no se convierte segundos
a milisegundos ni se recorta por antigüedad, porque MP reintenta entregas.
Los componentes ausentes se omiten del manifiesto, pero el handler de billing exige
que el recurso procesado esté presente en la URL firmada. Un ID sólo en el cuerpo
no se procesa. Firma ausente/inválida: 401; secreto no configurado: 500.

Fuentes oficiales consultadas:

- [Webhooks de suscripciones](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/additional-content/your-integrations/notifications/webhooks).
- [Construcción y validación del manifiesto](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/optional-notifications).
- [Búsqueda de facturas por preapproval](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get).
- [Consulta de factura autorizada](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get).

### Comprobaciones privadas exactas del owner

1. En la aplicación de MP que emitió el preapproval Plan B auditado, comprobar su
   `application_id` por consulta del recurso. Contrastar con la aplicación que
   posee el token productivo configurado para Billing SaaS.
2. En **Tus integraciones → esa aplicación → Webhooks → producción**, comprobar
   URL exacta del proyecto y función `mp-webhook`, y eventos
   `subscription_preapproval` / `subscription_authorized_payment`.
   Separar la configuración de pruebas, otras aplicaciones y Merchant Connect.
3. Comprobar localmente que `MP_WEBHOOK_SECRET` de la función productiva corresponde
   al secreto de **esa** configuración. No mostrar, copiar al PR ni enviar valores.
   No regenerarlo como hipótesis: una rotación requiere despliegue coordinado y
   autorización independiente.
4. Recuperar privadamente una entrega concreta: URL con query original,
   `x-signature`, `x-request-id`, cuerpo y momento. Comparar MP y gateway para saber
   si hubo transformación de ID, encoding, timestamp o headers. No usar una firma
   de otra entrega ni reconstruir el ID desde el cuerpo.
5. Ejecutar en un equipo propio el diagnóstico offline con Node compatible con
   el TypeScript del repositorio. El archivo privado tiene
   `{ "url": "...", "headers": { ... }, "body": { ... } }`. Mantener el secreto en
   el entorno local y ejecutar `npm run diagnose:beta-mp:signature -- <archivo-privado>`.
   No hay red y sólo imprime booleanos, nunca credenciales, headers o manifiesto.
   El archivo no debe vivir en el repositorio ni subirse a esta conversación.

Si la captura fiel pasa offline y falló en gateway, investigar transformación o
configuración desplegada. Si falla offline, contrastar la aplicación emisora,
la configuración productiva y el valor local antes de atribuirlo a un secreto incorrecto.
Registrar sólo resultados booleanos e IDs recortados en la evidencia compartida.
No desactivar firmas ni aceptar requests por su User-Agent.

## Ledger, autoridad e idempotencia

Se reutiliza `applyPreapprovalEvidence` para reconcile, webhooks y cancelación.
La identidad es el preapproval guardado por el servidor en una única sesión:
no se busca por email, plan, fecha, importe ni una referencia externa sola.
Si MP informa `external_reference`, debe coincidir con esa sesión.
La capacidad `subscription` se valida antes de las acciones; se conservan RLS,
GRANT y la prohibición de escritura del navegador.

La recuperación pagina `authorized_payments/search` exclusivamente con el ID
conocido, relee cada factura y su `/v1/payments/{id}`, y valida todas las respuestas
antes de empezar a persistirlas. Guarda invoice ID, preapproval ID y payment ID
distintos, estado real y fechas, con un payload mínimo sin datos de tarjeta/pagador.
`processed` de la factura no se traduce a `approved` del pago.
Un pago aprobado sin fecha válida, importes/monedas contradictorios o vínculos
inconsistentes bloquean la transición. Una fila de otro negocio nunca se reasocia.
Las facturas de un contrato reemplazado siguen perteneciendo a su sesión original
y no pueden reactivar ese contrato.

Se conserva el índice único por factura y se agrega
`uq_payments_mp_payment_id`, parcial para MP, contra dos facturas del mismo pago.
La migración `20261015120000` sólo agrega DDL: aborta ante duplicados existentes,
sin backfill, limpieza, cambios de RLS ni datos comerciales.
Los UPSERT sin cambios se omiten; escrituras condicionales del negocio protegen
contra evidencia concurrente y contra un acceso administrativo que cambió durante
la operación. La primera activación tiene un evento durable reclamado antes de
escribir negocio/sesión: el reintento termina ese mismo evento.

Antes de cerrar un checkout anterior con ID conocido, se confirma su baja en MP;
una etiqueta local expired no impide que un enlace siga siendo pagable. Esto cubre
contratos previos autorizados que nunca llegaron a activarse en businesses, además
del contrato canónico anterior. Cada cuota verificada se registra con su identidad
original. Una intención posterior todavía sin aprobación conserva su checkout.
No se cancela ni asocia el Plan A sin identidad local.

La [revisión de pagos fuera de orden del PR #179](ordering-review.md) corrige
la regresión reproducida sobre 050eb0b: una cuota aprobada antigua no puede borrar
un rechazo posterior. La decisión exige evidencia completa verificada del contrato,
incluyendo la factura notificada y el último pago conocido si search los omite.
Esto aumenta las lecturas por webhook; los límites de recuperación siguen vigentes.

Límites residuales:

- Verificación de reemplazo limitada a un historial de 100 sesiones: más historial bloquea
  la activación hasta auditarlo y ampliar la recuperación con pruebas. No se asume
  que un contrato omitido esté cancelado.
- Recuperación máxima de 100 facturas por suscripción. Paginación contradictoria,
  incompleta, cambiante o mayor al límite falla cerrada; requiere investigar y ampliar
  el límite con pruebas antes de recuperar contratos más largos.
- No existe transacción distribuida con MP ni entre todas las escrituras del flujo.
  Reconcile recupera el contrato vinculado y las sesiones abiertas que examina
  el flujo existente. Las facturas de contratos reemplazados se recuperan por
  sus notificaciones identificadas; no se reconstruye todo ese historial
  de forma automática. Recursos sin identidad local siguen sin asociación.
  El ledger puede persistirse y luego fallar la activación; se reintenta.
  El índice evita duplicados aun con concurrencia, pero un conflicto puede devolver
  error y necesita nueva lectura. Los eventos genéricos de cambios posteriores
  conservan la auditoría existente; no se promete atomicidad global.
- Una nueva cuota ya pagada y una cancelación anterior fallida pueden dejar dos
  contratos autorizados en MP. El plan nuevo no se activa; revisar
  `preapproval_superseded` con `processed=false` y el motivo
  `replacement_pending`. Verificar/reconcile **es una acción con escrituras y puede
  cancelar el contrato anterior**; no usarlo como consulta no destructiva.
- Se conservan la gracia de tres días, la baja con corte inmediato de acceso,
  precios, acceso administrativo y POS/Merchant Connect. La política futura de
  devolución/contracargo o suspensión administrativa no se redefine en este lote.

## Plan A del 2 de octubre — ARS 15.000

La evidencia histórica registra un pago aprobado de Básico mensual por ARS 15.000,
preapproval `33b5f5ad…25f8`, referencia vacía y siguiente vencimiento informado
entonces para el 02/11. No existe un vínculo local fiable con ese recurso.
La auditoría del 13/10 no pudo verificar su estado actual: MP exigía reautenticación
del owner. La fecha histórica no demuestra que siga activo ni que hoy vaya a renovar.

Hace falta que el owner consulte, estrictamente en lectura:

- ID completo del preapproval obtenido del comprobante/historial de MP,
  `application_id`, estado actual, importe/moneda/frecuencia,
  `next_payment_date` y fecha de última modificación.
- ID real del pago del 02/10 y de su factura autorizada; estado actual del pago,
  monto/moneda, aprobación y vínculo explícito invoice → preapproval → payment.
- Estado de los próximos cobros/intentos y comprobante del pagador. El nombre,
  email, fecha e importe no reemplazan esos IDs.

Hasta tenerlo, tratar la renovación como riesgo abierto. No modificar `payments`,
no vincularlo al negocio del smoke anterior ni cancelar/reintegrar este recurso.
Alternativas que requieren decisión y autorización separada del owner:
cancelar renovación confirmando después el estado, solicitar devolución del pago
identificado conforme a MP, o una compensación comercial explícita mediante el
circuito administrativo existente. Si se eligiera un nuevo checkout Plan B, resolver
primero el contrato antiguo para evitar doble cobro; no cobrar otra vez por defecto.

## Gates locales y CI

Verificación ejecutada en este candidato:

- 474 pruebas de billing/interfaz y firmas en Vitest; 33 contratos y diagnóstico
  privado sin exposición de valores en Node.
- 16 pruebas del handler real de webhook en Deno; check de los siete módulos
  compartidos de billing.
- Guard BETA-MP: 99 sabotajes detectados, cero falsos positivos; guard de los
  tres SQL de lectura.
- Matriz SQL de autoridad/RLS/GRANT y nueva restricción de identidad en PostgreSQL
  real; 67 comprobaciones del código contra PostgREST real.
- TypeScript, lint del frontend y build. Las advertencias existentes del build
  y de las pruebas no son evidencia de certificación comercial.
- Regresión de pantallas de suscripción BETA-1/BETA-UX-1C: 235 pruebas en siete archivos adicionales.

El guard de escrituras financieras y el de credenciales del frontend pasan.
Los guards generales de SECURITY DEFINER/exposición, al recorrer todas las migraciones
históricas, reportan respectivamente 2 y 21 hallazgos en archivos anteriores sin cambios
en este PR. La migración nueva pasa ambos guards por separado y no crea funciones ni
grants. No se modifica el baseline para ocultar esos hallazgos.

Para una estación con Supabase local ya iniciado:
`npm run test:beta-mp:recovery:local` clona **sólo el esquema**, crea su propia
base/instancia PostgREST, aplica migraciones allí y elimina sólo ese entorno al
terminar. No resetea la base local del usuario ni copia datos comerciales.
En CI, `test:beta-mp:local` usa la base desechable del job con las migraciones nuevas.
Las pruebas de MP son simuladas. No hubo sesión visual manual en el navegador;
el diseño y CSS existentes no se modificaron.

## Despliegue futuro — requiere autorización independiente

1. Revisar el PR y fijar el SHA aprobado. Confirmar primero la correspondencia
   aplicación/token/webhook/secreto del P0. Mantener cerrada la habilitación de
   clientes nuevos por el mecanismo comercial existente; no agregar una regla
   de acceso improvisada.
2. Tomar evidencia de referencia con [preflight](preflight-readonly.sql) y
   [postdeploy](postdeploy-verify-readonly.sql), y snapshot de billing por ID de los
   negocios que no participarán del smoke. No ejecutar reconcile para obtenerlo.
3. Comparar historial de migraciones remoto con el candidato. Las dos migraciones
   base BETA-MP deben estar aplicadas. Un dry-run debe listar **únicamente**
   `20261015120000_beta_mp_recovery_payment_identity.sql` para esta operación.
   Si aparece cualquier migración ajena, detenerse y aislar el artefacto autorizado.
   Si la precondición encuentra duplicados, investigar en lectura; no limpiarlos.
4. Con autorización expresa, aplicar esa migración, luego desplegar
   `mp-webhook` y `mp-subscription` desde el mismo SHA, y finalmente frontend.
   Conservar la configuración de gateway `verify_jwt=false` existente: las acciones
   validan JWT internamente y el webhook exige HMAC. No deshabilitar ninguna
   validación interna. Registrar versiones, SHA y comprobación de código publicado.
5. Ejecutar los SQL de lectura anteriores y
   [recovery-verify-readonly.sql](recovery-verify-readonly.sql). Índice válido,
   cero pagos duplicados y cero sesiones pagadas sin ledger aprobado válido.
   Una anomalía requiere diagnóstico, no reparación manual.
6. Comprobar autorización/RLS y firma ausente/inválida sin escribir estados
   financieros. Los 401 previos a autenticación están en logs de función/gateway,
   no necesariamente en `subscription_events`.
7. Ejecutar el smoke siguiente sólo cuando se autoricen el negocio QA, el gasto
   y el riesgo de renovación. Aún no habilitar clientes nuevos.

El frontend anterior funciona con el backend nuevo porque `paid` ya exige aprobación.
El frontend nuevo falla cerrado con un backend anterior sin `payment_confirmed`.
El índice puede permanecer durante un rollback de funciones. Volver al backend
anterior reintroduce activación por autorización: no presentarlo como un rollback
comercial seguro ni abrir ventas. No borrar pagos ni revertir datos como rollback.

La rama contiene `git.deploymentEnabled["codex/beta-mp-recovery"]=false` para que
publicar el PR no lance un preview de Vercel. No cambia la configuración de main.
Mergear main podría activar el despliegue habitual y exige autorización posterior.
Referencia: [configuración Git de Vercel](https://vercel.com/docs/project-configuration/git-configuration).

## Smoke final en negocio QA independiente

Crear/usar un negocio QA sin suscripción anterior, sin override administrativo y
sin compartir el negocio del Plan A antiguo. Autorizar previamente el plan/ciclo,
importe real y cuenta pagadora. Básico mensual hoy cuesta ARS 15.000 y renueva:
la prueba tiene costo y no incluye autorización implícita de devolución o baja.
Conservar evidencia privada completa; compartir sólo IDs recortados y resultados.

| Paso | Evidencia exigida | Criterio de aceptación |
|---|---|---|
| Checkout único | Sesión ID, negocio QA, catálogo del servidor, preapproval ID, referencia y enlace devuelto | Reintentar create antes del pago devuelve el mismo contrato; ningún otro negocio ni acceso cambia. |
| Primera cuota | GET de factura y pago por IDs nativos vinculados al preapproval | Pago `approved`, fecha de aprobación, importe/moneda correctos. Si sólo está autorizado/pendiente, el smoke sigue pendiente. |
| Activación | Snapshot antes/después del negocio y sesión, evento de activación | Plan correcto del QA, origen MP, sesión consumida y prueba explícita de pago; autorización sola no activa. |
| Ledger | Consulta por negocio/preapproval/invoice/payment | Una única fila por factura y pago, ARS y monto exactos, plan correcto, payload sin datos privados. |
| Webhook autenticado | Entrega de MP, verificación privada de firma, logs de función y evento procesado | Firma válida y procesamiento exitoso del recurso correcto. Un HTTP 200 o un User-Agent solo no bastan. |
| Reconciliación | Verificar pago con autoridad del owner del QA, repetir y comparar filas/eventos | Converge al mismo resultado, no duplica ledger/activación ni concede acceso por una etiqueta. |
| Aislamiento | Snapshots del resto de negocios y pruebas de capacidad de otro usuario | Ningún cambio ajeno; otro tenant/rol sin capacidad obtiene 403. |
| Estado futuro | Lectura actual de MP tras terminar | Preapproval autorizado, importe/frecuencia y siguiente vencimiento verificados y anotados; no inferirlos desde la UI. |

Para demostrar recuperación sin notificación, usar un escenario QA separado autorizado
en el que haya evidencia de que la notificación no se aplicó antes de reconcile.
No apagar el webhook global ni fabricar un pago aprobado. Reconciliar después de
un webhook ya aplicado demuestra convergencia e idempotencia, no un webhook perdido.

Renovación, cambio de plan y cancelación requieren **pruebas reales separadas**:

- Renovación: siguiente factura/pago, monto, ledger único y período informado por MP.
  El rechazo y recuperación de mora requieren escenarios autorizados específicos.
- Cambio de plan: nueva cuota aprobada, contrato anterior leído como cancelado antes
  de activar el nuevo, fechas futuras y ausencia de otro contrato cobrando.
  No inducir fallos sobre un cliente comercial para probar recuperación parcial.
- Cancelación: acción expresamente autorizada del QA, GET posterior cancelado,
  estado local coherente y repetición sin otro efecto. Verificar qué queda del
  período ya pagado bajo la política vigente de corte inmediato.

El owner debe resolver: correspondencia privada del P0, destino comercial del Plan A,
autorización de despliegue/smoke/costos y pruebas reales adicionales. Sólo las ocho
evidencias del smoke aceptadas permiten declarar el circuito certificado; este PR
por sí mismo no habilita ventas.
