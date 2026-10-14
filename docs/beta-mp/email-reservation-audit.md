# BETA-MP-EMAIL — auditoría de la reserva antigua sin preapproval

Fecha: 14/10/2026. Alcance: historia del repositorio, lecturas productivas
expresamente autorizadas por identidad y procedimiento propuesto para el PR #180.
Esta auditoría no invocó Mercado Pago ni modificó sesiones, contratos, pagos,
acceso o datos comerciales. No certifica el circuito real ni autoriza operaciones
posteriores.

## Preflight informado

**Evidencia reportada por el usuario; no releída por esta auditoría:**

| Observación | Resultado informado |
|---|---:|
| Negocios con checkouts `pending` duplicados | 0 |
| Sesiones `pending` con `mp_preapproval_id` | 2 |
| Sesiones `pending` sin `mp_preapproval_id` | 1, creada el 02/10/2026 |
| Sesiones `expired`/`failed` con `mp_preapproval_id` | 0 |
| Índice nuevo `uq_scs_pending_business` | Aún no instalado |
| Última migración aplicada | `20261015120000` |

Estos conteos globales no se repitieron durante la auditoría. Posteriormente el
usuario aportó identidad y timestamps exactos y autorizó exclusivamente lecturas
productivas acotadas a esos datos y a la ventana de logs indicada abajo. Los
conteos no prueban la ausencia de contratos o pagos fuera del vínculo local.

## Lecturas autorizadas efectuadas

Evidencia obtenida el 14/10/2026 a las 20:21 UTC (17:21 de Argentina), mediante el
conector Supabase del proyecto de TechRepair Pro. No se usaron secretos locales,
correos del pagador, `reconcile`, el checkout ni APIs de Mercado Pago. Los IDs
completos y las consultas quedaron sólo en un archivo local ignorado por Git:
`test-results/artifacts/beta-mp-email-reservation-audit/read-only-evidence.json`.
Los resultados siguientes están anonimizados para el PR.

| Lectura acotada | Observación |
|---|---|
| Sesión por ID + negocio + referencia + timestamp completo + plan MP + `pending` + ID NULL, todos aportados por el usuario | Una sola fila coincide. Creada el 02/10 a las 12:45:25.317394 UTC y actualizada a las 12:48:18.453 UTC; Básico mensual, ARS 15.000; `mp_preapproval_plan_id` presente; `mp_preference_id`, `mp_preapproval_id` y `confirmed_at` NULL. |
| Negocio por su ID exacto | `trialing`, sin plan, `access_source`, preapproval vinculado, último pago ni períodos de suscripción. `subscription_provider = mercadopago` es metadata local y no demuestra un contrato o cobro real. |
| Eventos por el negocio exacto o por ID/referencia exactos de esa sesión | Cero coincidencias. No se amplió la búsqueda a otros negocios o referencias. |
| Logs entre `2026-10-02T12:40:00Z` y `2026-10-02T12:55:00Z`, exigiendo uno de los IDs aportados en los atributos y restringiendo luego a billing/funciones | Dos GET de sesiones por ese negocio, a las 12:45:24.807 y 12:48:18.462 UTC; un PATCH histórico de esa sesión exacta a las 12:48:18.935 UTC, respuesta 204. Cliente Deno/Supabase Edge Runtime. |

El PATCH es evidencia de una operación histórica; esta auditoría sólo leyó sus
logs. No se obtuvo su cuerpo, la respuesta del request original de checkout ni
la versión desplegada que lo atendió. Una consulta inicial de logs por identidad
de negocio alcanzó el límite de 50 filas de tráfico genérico; la consulta
posterior restringida a billing devolvió las tres filas de arriba. No se guardan
headers, información de autenticación ni IPs en el artefacto privado.

No se recuperó un mensaje de creación correlacionado por ID en los atributos
seleccionados. Esto no equivale a ausencia de invocaciones: un mensaje sin esos
IDs en los atributos queda fuera del filtro. Tampoco se consultó el proveedor,
ni se estableció que no haya un recurso remoto. El snapshot refuerza la
compatibilidad con Plan A; no demuestra qué contrato, si alguno, se originó en
ese checkout.

## Qué explica la historia del repositorio

1. **Antes de Plan A**, el cliente intentaba insertar la sesión y conservaba
   `res.preapproval_id` en `mp_preference_id`, no en la columna posterior
   `mp_preapproval_id`. El discovery del 01/10 documentó la tabla vacía y falta de
   privilegios de inserción tanto del cliente como del backend. Es una variante
   histórica que debe distinguirse mediante evidencia, no presumirse como origen
   de esta fila. Ver [servicio anterior a Plan A](https://github.com/molinajonyy-hub/TechRepair-Pro/blob/e44d6915ef8e6e28bc197b4fb5c9cbe4b6dfb757/src/services/subscriptionService.ts#L136)
   y [discovery de autoridad de checkout](../../supabase/migrations/20261012120000_beta_mp_checkout_session_server_authority.sql).
2. **Plan A** ([commit `887e812`, 01/10/2026](https://github.com/molinajonyy-hub/TechRepair-Pro/commit/887e812d832dc189674a2f82fac82c9ff5a8025c))
   creaba una intención local y abría el checkout por URL de un
   `preapproval_plan`. No hacía `POST /preapproval` para esa intención. Devolvía
   deliberadamente `preapproval_id: null`; por eso una sesión con NULL podía
   haber abierto un checkout y producido un contrato real. Ver
   [creación de la sesión y URL](https://github.com/molinajonyy-hub/TechRepair-Pro/blob/887e812d832dc189674a2f82fac82c9ff5a8025c/supabase/functions/_shared/billing/subscriptionActions.ts#L150)
   y [respuesta con ID nulo](https://github.com/molinajonyy-hub/TechRepair-Pro/blob/887e812d832dc189674a2f82fac82c9ff5a8025c/supabase/functions/_shared/billing/subscriptionActions.ts#L179).
3. El [runbook histórico del 02/10](runbook-rollout.md#estado-medido-producción-sólo-lectura-2026-10-02-1310-utc)
   registra dos sesiones `pending` sin ID antes de Plan B. Su
   [smoke de Plan A](runbook-rollout.md#evidencia-real-del-smoke-del-2026-10-02)
   documenta un pago real aprobado y un preapproval cuya referencia volvió vacía,
   sin vínculo local fiable. Las sesiones se conservaron como registro.
   La [migración de Plan B](../../supabase/migrations/20261013120000_beta_mp_plan_b_session_preapproval_unique.sql)
   también identifica aquellas dos filas NULL como checkouts Plan A.
4. **Plan B** ([commit `70564d7`, 02/10/2026](https://github.com/molinajonyy-hub/TechRepair-Pro/commit/70564d737d4aa05b79f53fbb5ab50320b8cfd8de))
   inserta la reserva, crea el preapproval por API y guarda el ID antes de
   devolver el checkout. Una interrupción entre esos pasos puede dejar NULL.
   Un timeout o la pérdida de respuesta no demuestra que el proveedor no creó el
   recurso. Ver [secuencia de creación y vínculo](https://github.com/molinajonyy-hub/TechRepair-Pro/blob/70564d737d4aa05b79f53fbb5ab50320b8cfd8de/supabase/functions/_shared/billing/subscriptionActions.ts#L178).

**Conclusión limitada:** el plan MP presente, el ID nulo, los accesos desde Deno
y la ventana de creación son compatibles con el flujo servidor de Plan A y con
el discovery histórico. No se recuperó evidencia directa del handler original
que permita cerrar la procedencia; una interrupción de Plan B es otra categoría
posible para reservas NULL en general, no una causa demostrada para esta fila.
No se asocia esta fila con el contrato del smoke histórico ni con otro recurso
de MP. Las versiones de archivo de migración tampoco establecen qué versión de
función atendió cada request.

## Evidencia necesaria, acotada por identidad

Mantener el expediente privado; el PR sólo conserva resultados anonimizados. El
snapshot de sesión y negocio y las lecturas de eventos/logs descritas arriba ya
se obtuvieron. Siguen faltando evidencia directa del request original, versión
de función, autorización del owner para cualquier intervención y, si se decide
investigarlo con autorización separada, evidencia del proveedor. No copiar
correos, payloads con datos personales ni IDs comerciales reales al PR.

- Identidad exacta de `subscription_checkout_sessions`: `id`, `business_id`,
  `user_id`, `external_reference`, `status`, `created_at`, `updated_at`,
  `confirmed_at`, `plan_id`, `billing_cycle`, `amount`, `currency`,
  `mp_preapproval_plan_id`, `mp_preapproval_id` y el campo histórico
  `mp_preference_id`. Consultar `payer_email` sólo dentro del expediente si aporta
  contexto; jamás usarlo para establecer pertenencia.
- Estado del negocio identificado: `id`, `subscription_status`,
  `subscription_plan`, `access_source`, `mp_preapproval_id`,
  `mp_preapproval_plan_id`, `last_payment_id`, `last_payment_status` y períodos
  vigentes. Comprobar la autorización del owner para ese negocio.
- Historial de sesiones de ese mismo negocio y eventos/pagos vinculados por IDs
  locales o nativos ya conocidos. Conservar sus estados y no escribirlos.
- Logs del request original y de sus reintentos, correlacionados con esa sesión:
  request/correlation ID, timestamp completo y zona, versión desplegada de la
  función, respuesta HTTP, eventos `checkout_opened`, `preapproval_rejected`,
  `checkout_session_not_closed`, errores y cualquier ID de recurso registrado
  por el servidor. No reconstruir identidad por proximidad temporal.
- Si se autoriza posteriormente una investigación real de MP: evidencia del
  owner/proveedor con ID completo del contrato y su aplicación creadora, estado
  actual, fecha de modificación y cadena nativa factura → preapproval → pago.
  Un recibo o historial debe permitir contrastar esos IDs; nombre, email, fecha,
  plan e importe no reemplazan esa identidad.

La ausencia de logs, webhooks, vínculo local o pagos en un conteo no demuestra que
no exista un recurso remoto. Una búsqueda incompleta o retención vencida de logs
debe registrarse como incertidumbre, no como permiso para liberar la reserva.

## Procedimiento propuesto — no ejecutado

1. Conservar el snapshot ya obtenido y su alcance autorizado. Cualquier futura
   relectura o ampliación requiere respetar la identidad y autorización de ese
   momento. Registrar quién aportó cada evidencia y su momento de observación.
   Si falta evidencia o es contradictoria, mantener el bloqueo y derivar al
   owner.
2. Clasificar la procedencia con columnas y logs originales. Una referencia
   `trpcs_…` por sí sola no distingue Plan A de Plan B. Nunca asignar un
   preapproval a esta sesión por email, importe, plan, fecha o cercanía de logs.
3. **Aislamiento propuesto mediante el candidato:** conservar la fila `pending` sin ID. El PR consulta
   pendientes por negocio y bloquea la creación de un nuevo checkout para ese
   negocio cuando la reserva sin ID supera el margen de ejecución. No cancela
   recursos ni modifica el acceso vigente para aislarla. El índice nuevo admite
   esta única fila: no exige borrarla, vencerla ni asociarla automáticamente.
   El candidato no fue desplegado: no presumir que producción ya cuenta con ese
   bloqueo. Hasta un release autorizado, evitar iniciar checkout/reconcile para
   el negocio investigado y mantener el caso en soporte, sin modificar la fila.
4. Si sigue sin probarse la ausencia de un contrato potencialmente cobrable,
   conservar el aislamiento y documentar la incertidumbre. El
   [procedimiento del Plan A antiguo](recovery-runbook.md#plan-a-del-2-de-octubre--ars-15000)
   ya exige evidencia actual del owner; su estado histórico no prueba su estado
   actual. No iniciar otro checkout por defecto.
5. Sólo con autorización independiente, explícita y acotada a los IDs concretos,
   preparar la intervención elegida por el owner. Una eventual cancelación real
   debe confirmar después el estado del mismo recurso; un error, estado
   desconocido o confirmación ausente conserva el bloqueo. Un contrato activo o
   un pago real no se borra ni se cancela por una diferencia de correo.
6. Una eventual liberación local requiere otra autorización concreta y un plan
   revisable: comprobar de nuevo la identidad y el snapshot, excluir operaciones
   concurrentes para ese negocio, usar un cambio condicional sobre esa única
   sesión y abortar si no coincide exactamente una fila. La decisión debe
   apoyarse en evidencia suficiente sobre el riesgo remoto, no sólo en antigüedad
   o NULL. Mantener la fila y su trazabilidad; no tocar el ledger ni otorgar
   acceso. No se proporciona ni ejecuta DML de reparación en este documento.
7. Después de la intervención autorizada, registrar evidencia antes/después y
   cualquier incertidumbre restante. Abrir un nuevo checkout, reconciliar,
   cancelar, reintegrar o modificar acceso son acciones separadas; ninguna queda
   autorizada por aprobar este diagnóstico o aplicar el índice.

## Límites operativos

Toda operación real de Mercado Pago, incluso una consulta por API, y toda
escritura productiva requieren autorización independiente antes de ejecutarse.
Este PR no otorga esa autorización.

**«Verificar pago»/`reconcile` no es una consulta de sólo lectura.** El handler
llama a `applyPreapprovalEvidence`, que puede escribir sesiones, eventos, pagos y
estado del negocio; Recovery también puede cancelar un contrato anterior al
resolver un reemplazo. No usar el botón, el endpoint ni una pantalla que invoque
reconciliación como sustituto de un SELECT de diagnóstico. Ver
[handler de reconcile](../../supabase/functions/_shared/billing/subscriptionActions.ts)
y [aplicación de evidencia y reemplazos](../../supabase/functions/_shared/billing/preapproval.ts).

La única autoridad para activar el plan sigue siendo un pago real `approved`,
verificado mediante la cadena de identidad y el ledger de BETA-MP-RECOVERY. La
reserva, el email, el retorno del checkout o un preapproval `authorized` no
conceden acceso.
