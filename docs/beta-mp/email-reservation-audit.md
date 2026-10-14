# BETA-MP-EMAIL — auditoría de la reserva antigua sin preapproval

Fecha: 14/10/2026. Alcance: historia del repositorio y procedimiento propuesto para
el PR #180. Esta auditoría no consultó producción ni Mercado Pago y no modificó
sesiones, contratos, pagos, acceso o datos comerciales. No certifica el circuito
real ni autoriza operaciones posteriores.

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

No se proporcionaron el ID de esa sesión, su negocio, referencia, hora completa
ni logs. Los conteos no permiten identificarla ni concluir por qué quedó así.
Tampoco prueban la ausencia de contratos o pagos fuera del vínculo local.

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

**Conclusión limitada:** una reserva Plan A es una explicación compatible con la
fecha y el discovery histórico. Una ejecución Plan B interrumpida es otra
posibilidad. No hay evidencia suficiente para atribuir esta fila a ninguna de
ellas ni para asociarla con el contrato del smoke histórico. Las versiones de
archivo de migración tampoco establecen cuándo se ejecutó cada request o qué
versión de función lo atendió.

## Evidencia necesaria, acotada por identidad

Preparar un expediente privado; el PR sólo debe conservar resultados anonimizados.
No copiar correos, payloads con datos personales ni IDs comerciales reales al PR.

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

1. Obtener el snapshot anterior mediante lecturas estrictamente acotadas al ID de
   sesión y al negocio reportados. Registrar quién aportó cada evidencia y su
   momento de observación. Si falta identidad o la evidencia es contradictoria,
   mantener el bloqueo y derivar al owner.
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
