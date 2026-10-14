# BETA-MP-EMAIL — checkout y correo del pagador

Fecha: 14/10/2026. Rama: `codex/beta-mp-email`. Base: `origin/main` actualizado,
`fccce50` (PR #179, BETA-MP-RECOVERY). Esta entrega prepara código y PR; no habilita
una intervención en producción.

## Revisión posterior del PR #180

El commit inicial `eefb51d` terminó con **CI 14/14 verde**; se verificó también la
ejecución [38620624466](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/38620624466).
Ese resultado certifica los tests de ese commit, no resuelve por sí solo la carrera
de estado del proveedor descubierta en la revisión posterior.

La migración candidata se reasignó a **`20261016120000`**, posterior a
`20261015120000`, última versión productiva reportada, y a todas las demás
migraciones versionadas del repositorio. El SQL es idéntico al candidato inicial:
la revisión sólo cambia su versión y referencias. Un contrato de tests comprueba
el orden y la unicidad del archivo; el guard impide una versión anterior o DML de
limpieza. No se ejecutó reparación de historial ni migración productiva.

El [informe de la reserva antigua](email-reservation-audit.md) distingue el preflight
reportado de las lecturas autorizadas por identidad. La fila del 02/10 se conserva
sin modificación ni asociación. Su plan de MP poblado y el historial son
compatibles con Plan A, sin demostrar qué ocurrió en MP. NULL y antigüedad no
prueban que no exista un contrato remoto. Una única reserva sin ID es compatible
con el índice y queda aislada por negocio.

La revisión independiente reprodujo con mocks una autorización —con y sin pago
remoto aprobado— entre GET `pending` y PUT de cancelación: el candidato inicial
cancelaba el contrato ya autorizado y creaba otro. Dos pruebas de regresión
expresan la invariante segura; una segunda lectura por sí sola no elimina esa
ventana. La [API de actualización revisada](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/update-preapproval/put)
documenta `version` en la respuesta, pero no una precondición de estado que nuestro
cliente pueda usar para cancelar sólo si sigue pendiente. No se ejecutó esta
reproducción contra Mercado Pago real.

**Decisión autorizada e implementada:** conservar la reutilización compatible y
bloquear un pendiente incompatible sin enviar PUT. Sólo se permite reemplazarlo
si la lectura por el ID del servidor ya devuelve `cancelled`/`canceled`, sin pago
aprobado en el ledger ni vínculo vigente al mismo recurso. La corrección de un
checkout pendiente incompatible requiere soporte y recuperación por identidad;
no se intenta cambiar ni cerrar el contrato automáticamente. Esta política también
se aplica a diferencias de plan, ciclo, precio o vigencia. La API no ofrece una
precondición atómica documentada; no se presenta otra lectura como garantía.

Las dos regresiones de carrera fallaron en `fefb18f` y en
[su CI](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/38627962220)
con 200 en lugar de 409. Conservan sus expectativas y ahora pasan: tanto una
autorización sola como un pago remoto ocurrido después del snapshot `pending`
terminan sin PUT, segundo POST, alteración de acceso ni ledger ficticio.

La revisión final también reprodujo un fallo heredado de `main`: si fallaba el
vínculo tras POST y la cancelación de limpieza fallaba o no se aplicaba, se
cerraba la sesión como `failed` y el retry emitía otro POST con el primer recurso
aún pendiente. El descarte ahora sólo lee el ID recién creado y devuelve éxito
si ya confirma cancelación e identidad. Una respuesta inválida, vínculo fallido
o cleanup incierto conserva la reserva `pending`, sin checkout entregado ni PUT
automático. No se concede acceso ni se cancela un contrato autorizado por ese error.

### Validaciones de esta revisión

- Migración renumerada con SQL idéntico; referencias de runner, CI y documentación
  actualizadas. Test de orden/versionado aprobado, y guard con **110 sabotajes**
  aprobados sin falsos positivos.
- `npm run test:beta-mp`: **34 unitarios y 531 tests de billing/Recovery aprobados**,
  en 13 archivos, sin tests omitidos. Incluye las dos regresiones de carrera sin
  cambiar sus expectativas, bloqueo de reintentos, concurrencia sobre pendientes
  y cancelados, CAS ante estados locales concurrentes y pago aprobado ya presente
  en ledger aunque falle el cierre local. También cubre respuesta inválida y
  vínculo fallido con cleanup incierto: conserva la reserva y bloquea el retry.
  Los fixtures con dos intenciones
  anteriores al índice se declaran históricos para conservar la regresión Recovery.
- Frontend **76/76** y aislamiento de reserva legacy **2/2**, incluidos en el total.
  Checkout directo sin campo adicional, correo opcional y un NULL antiguo intacto
  que bloquea sólo su negocio, sin asociación automática de Mercado Pago.
- `npm run test:beta-mp:recovery:local`: **79 comprobaciones aprobadas** en
  PostgreSQL/PostgREST temporal con la versión nueva, sin datos comerciales ni MP
  real. Incluye GET `pending` seguido de autorización antes de entregar la
  respuesta: cero PUT/segundo POST, reserva, ledger y acceso sin cambios.
- TypeScript real, ESLint, Deno check, build y guard de SQL de sólo lectura
  aprobados. Persisten los avisos de build ya descritos en la evidencia inicial.
- Chrome con componentes reales y servicio/auth simulados: 375/1440 px, claro y
  oscuro; checkout predeterminado directo, correo opcional retenido en memoria,
  error del proveedor sin diálogo de correo y un único reintento manual.
  Sin overflow ni errores de página, controles relevantes >=44 px e input >=16 px.
  Toda solicitud externa bloqueada; capturas y reporte guardados en artefactos
  locales `email-ui-review`. No hubo llamada al backend ni a MP real.

La certificación local no acredita un checkout real del proveedor. El CI del
nuevo commit debe verificarse por su SHA; el 14/14 del inicial no se transfiere.

## Discovery y resultado

`Plans` ya enviaba el checkout sin correo explícito; el servidor tomaba el correo
autenticado. Sólo un rechazo durante `POST /preapproval` abría
`MercadoPagoEmailDialog`. Si MP aceptaba crear el recurso y rechazaba después al
usuario dentro del checkout, no había una corrección previa accesible.

`findOpenCheckout` consultaba un pendiente del mismo negocio/plan/ciclo. Si el
correo, precio o vencimiento diferían, podía marcarlo `expired` sin cancelar el
preapproval. El índice anterior tampoco impedía dos pendientes de planes distintos.

Ahora el camino predeterminado sigue directo, sin formulario. La opción
«¿Usás otro correo en Mercado Pago?» abre el diálogo existente; guardar el dato no
llama al servidor. Elegir el plan envía `mp_payer_email` si el usuario lo indicó.
Cancelar o volver al correo de TechRepair Pro conserva el camino predeterminado.
El dato vive en memoria, no se persiste en el navegador ni decide identidad,
pertenencia o acceso. No afirmamos detectar el correo de MP.

`/subscription/failure` y `/subscription/pending` permiten volver a Planes y
corregir el correo sin crear nada automáticamente. Los errores generales siguen
siendo errores generales. `failure` ya no promete un trial vigente sin evidencia.
Los bloqueos de reemplazo ofrecen «Verificar pago».
Los errores generales, incluso después de elegir otro correo, muestran su causa
sin pedir una corrección de email. Sólo los códigos específicos de correo abren
ese diálogo. El correo elegido se conserva en memoria para un reintento manual;
no se atribuye al correo del login un rechazo del correo indicado.

## Backend e invariantes

1. Autorizar negocio con JWT/capacidad antes de cualquier operación.
2. Consultar pendientes por negocio, independientemente de plan/ciclo o del tamaño
   del historial. Duplicados históricos bloquean sin elegir un recurso arbitrario.
3. Leer el preapproval por el ID guardado por el servidor. Validar ID, negocio y
   ausencia de contradicción en la referencia; MP puede omitir esa referencia.
4. `authorized` bloquea un nuevo checkout. Un recurso vinculado a la suscripción
   vigente o con pago aprobado en el ledger tampoco se cancela por cambiar correo.
   El mismo plan/ciclo ya contratado no se vuelve a contratar por otro correo.
5. Reutilizar sólo intención, correo normalizado, vigencia, condiciones y enlace
   compatibles. Un `pending` incompatible bloquea sin PUT: puede autorizarse
   entre la lectura y una cancelación. Sólo `cancelled`/`canceled` ya confirmado
   permite cerrar la sesión y reservar un reemplazo. No se automatiza la baja.
6. Errores, 404, identidad contradictoria, `paused`, estado desconocido o
   cancelación sin confirmar conservan la reserva y bloquean el nuevo POST.
7. Cierre condicional por sesión/negocio/estado pendiente/preapproval/referencia:
   sólo un request puede liberar la sesión. Un índice único parcial por negocio
   impide reservas paralelas incluso entre planes o ciclos distintos.
8. Un timeout/5xx, respuesta inválida o vínculo fallido no demuestran que MP no
   creó el recurso. Se conserva la reserva sin ID; pasado el margen de ejecución
   requiere revisión de soporte. Sólo una relectura por ID propio ya cancelado
   permite cerrar como `failed` un descarte sin vínculo. No se intenta cancelar
   automáticamente el recurso incierto para liberar el retry.
9. No cambia el camino canónico de Recovery: sólo un pago real `approved`, con
   identidad y condiciones verificadas en el ledger, puede activar. No se borran
   pagos ni se concede acceso por correo, retorno del navegador o autorización sola.

## Recuperación de un checkout bloqueado por identidad

Procedimiento de soporte propuesto; no ejecutado por este PR:

1. Abrir un expediente privado con el owner y la identidad exacta de negocio,
   sesión, referencia y preapproval guardado por el servidor. El correo ingresado
   no demuestra pertenencia. Si falta el ID, seguir la
   [auditoría de reserva histórica](email-reservation-audit.md); no inferirlo.
2. Con autorización de lectura del proveedor, contrastar el mismo ID y su estado
   actual. `authorized`, evidencia de pago, identidad contradictoria o respuesta
   incierta mantienen el bloqueo. Un error del checkout no demuestra que el
   contrato no se haya autorizado en otra pestaña.
3. Si sigue `pending`, conservar la reserva. Cualquier baja que decida el titular
   es una operación comercial separada con autorización explícita por ID; la
   lectura previa no condiciona atómicamente esa baja. No cancelar una suscripción
   activa por una diferencia de correo ni ejecutar una limpieza local para
   habilitar otra contratación.
4. Sólo tras una eventual baja autorizada y confirmada en el mismo recurso,
   permitir un reintento manual. El candidato relee MP, comprueba vínculo/pago y
   cierra condicionalmente la reserva; ningún error, confirmación ausente o
   conflicto concurrente habilita otro POST.
5. Mantener los pagos y la trazabilidad. `reconcile` es una operación con
   escrituras y puede ejecutar cancelaciones de Recovery; requiere autorización
   operativa propia, no sirve como consulta diagnóstica de sólo lectura.

La evidencia tardía sigue el algoritmo existente de Recovery: este microfix no
introduce una transacción distribuida con MP ni altera su autoridad. Liberar la
reserva no solicita reactivar el contrato ni generar un cobro; cualquier aplicación
de acceso requiere el pago `approved` verificado. No se certificó el comportamiento
del proveedor con contratos reales.

## Archivos y alcance

| Archivos | Cambio |
| --- | --- |
| `src/pages/Plans.tsx` | Correo opcional, bloqueo síncrono de doble envío y salida a verificar pago. |
| `src/components/subscription/MercadoPagoEmailDialog.tsx` | Reutilización previa al checkout, validación, input de 16 px, botones de 44 px y footer adaptable. |
| `src/pages/SubscriptionFailure.tsx`, `src/pages/PaymentPending.tsx` | Regreso para corregir y mensajes que dependen de evidencia. |
| `src/services/subscriptionService.ts` | Documentación del contrato existente, sin persistencia ni cambio de payload. |
| `supabase/functions/_shared/billing/subscriptionActions.ts`, `store.ts` | Lectura por ID, bloqueo sin cancelación automática, reserva por negocio y cierre condicional sólo tras cancelación confirmada. |
| `supabase/migrations/20261016120000_beta_mp_email_one_pending_business.sql` | Índice único por negocio pendiente; cero limpieza de datos, permisos o RLS. |
| `tests/components/betaMp/*`, `tests/unit/billingContracts.test.ts` | Casos nuevos y regresión; fixtures históricos explícitos para Recovery. |
| `tests/sql/beta_mp_checkout_authority.test.sql`, `scripts/billing/*` | Restricciones y CAS contra PostgreSQL/PostgREST reales, MP simulado. |
| `scripts/guards/beta-mp-billing-authority.mjs` | Conserva autoridad, admite la opción UX y exige cierre confirmado. |
| `.github/workflows/ci.yml` | Aísla la nueva migración en jobs que prueban etapas anteriores; billing usa el candidato completo. |
| `vercel.json` | Desactiva despliegues automáticos sólo para esta rama de PR. |

No hay rediseño general, cambios de catálogo/precios, webhook, ledger, algoritmo de
activación, POS, Mi Guita, dependencias ni contratos de facturación.

## Evidencia inicial de validación (`eefb51d`)

- `npm run test:beta-mp`: guard + self-test (101 sabotajes), SQL operativo de sólo
  lectura, 33 tests unitarios y 507 tests de billing/Recovery, todos aprobados.
- `npm run test:beta-mp:recovery:local`: clon **sólo del esquema** de Docker local,
  base y PostgREST temporales, migraciones candidatas, matrices SQL y 74
  comprobaciones de integración. MP HTTP simulado; no se copian datos comerciales.
  El contenedor temporal y la base temporal se eliminan al terminar.
- TypeScript real (`node ../../node_modules/typescript/bin/tsc --noEmit`),
  `npm run lint:errors`, `npm run build`,
  `deno check --no-lock supabase/functions/_shared/billing/subscriptionActions.ts`.
- `node scripts/finance/guard-readonly-sql.mjs docs/beta-mp/email-preflight-readonly.sql`.
- Regresión adicional: 69 casos de `betaUx1cSubscriptionPage` y
  `beta1TrialEndBilling` pasaron con registro local explícito de matchers.
  El comando estándar falló con 19 `Invalid Chai property` en los node_modules
  compartidos de esta máquina; el override local sólo carga los matchers existentes,
  sin omitir pruebas ni modificar configuración o dependencias del PR.
- Navegador Chrome, componentes reales y bordes simulados: 375 y 1440 px, claro y
  oscuro, opción inicial cerrada, validación, corrección, una redirección, retorno
  desde fallo, sin overflow, botones >=44 px, input >=16 px y sin errores de página.
  Todas las solicitudes externas se bloquearon. Capturas guardadas en los
  artefactos locales de la entrega.
- Build local sin `VITE_CONTACT_WHATSAPP`: aviso existente de canal ausente fuera
  de producción; también persiste el aviso de chunks grandes. No se cargaron
  variables de producción para resolver esos avisos.

Las pruebas no certifican el checkout alojado por Mercado Pago ni sustituyen un
smoke autorizado del proveedor. No se ejecutaron cobros, cancelaciones remotas,
migraciones productivas, merge ni deploy.

## Riesgos y checklist de despliegue — NO ejecutado

- [ ] Obtener autorización separada para release, ventana de billing y cualquier
  operación de Mercado Pago. Mantener la rama sin preview automático.
- [ ] Confirmar que BETA-MP-RECOVERY está desplegado con su migración de identidad
  de pagos, configuración y firma de webhook. Este cambio no sustituye Recovery.
- [ ] Ejecutar `email-preflight-readonly.sql` con acceso autorizado. Duplicados
  bloquean la instalación del índice. Reservas sin ID se conservan y aíslan por
  negocio hasta revisar su identidad; no requieren limpieza para instalarlo.
  Contratos retirados localmente con estado remoto incierto requieren revisión
  por ID. No borrar pagos ni cancelar contratos para hacer pasar el índice.
- [ ] Revisar duplicados históricos antes de aplicar el índice. La migración falla
  si existen duplicados o no consigue el lock en 5 segundos; no modifica filas.
  Verificar que la versión candidata `20261016120000` siga siendo posterior a
  todas las versiones aplicadas al momento del release; no ejecutar un push
  remoto ciego ni reparar historial para adaptar el orden anterior.
- [ ] En la ventana autorizada, coordinar la restricción de nuevas contrataciones
  mientras se instala y verifica el índice, luego actualizar `mp-subscription` y
  el frontend. No habilitar el backend nuevo sin la protección del índice.
- [ ] Verificar permisos intactos, un pendiente por negocio, reuso y reemplazo con
  proveedor simulado o entorno de pruebas; revisar las respuestas 409/502/503.
- [ ] Verificar que un pendiente incompatible responde 409 sin PUT ni segundo
  POST, y que `authorized` tampoco se reemplaza. Un caso bloqueado se resuelve
  por identidad con soporte; cualquier operación comercial requiere autorización
  independiente. Sólo un recurso ya cancelado y verificado habilita el reintento.
- [ ] Autorizar por separado un negocio QA, cuenta pagadora, plan/ciclo y cualquier
  gasto/renovación antes de un smoke real con correos iguales/diferentes.
- [ ] Verificar retorno pending, primer pago aprobado en ledger y convergencia de
  webhook/reconcile sin duplicados; comprobar que autorización sola no activa.
- [ ] Monitorear rechazos y reservas bloqueadas. Un timeout, respuesta inválida o
  vínculo fallido sin ID puede requerir intervención de soporte y se bloquea
  deliberadamente para evitar un segundo recurso incierto. No resolverlo
  expirando filas sin evidencia remota.
- [ ] Para rollback, conservar el índice y detener nuevas contrataciones si se
  vuelve al código previo. Volver al `findOpenCheckout` anterior reintroduce el
  riesgo; no borrar pagos ni revertir estados comerciales como rollback.

Referencias consultadas: [Mercado Pago: obtener suscripción por ID](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval/get),
[gestión de suscripciones](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/subscription-management),
[PostgreSQL: índices parciales únicos](https://www.postgresql.org/docs/current/indexes-partial.html),
[Vercel: desactivar deploy por rama](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled),
[Supabase: pruebas de Edge Functions](https://supabase.com/docs/guides/functions/unit-test).
