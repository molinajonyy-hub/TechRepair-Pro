# BETA-MP-EMAIL — checkout y correo del pagador

Fecha: 14/10/2026. Rama: `codex/beta-mp-email`. Base: `origin/main` actualizado,
`fccce50` (PR #179, BETA-MP-RECOVERY). Esta entrega prepara código y PR; no habilita
una intervención en producción.

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
   compatibles. Para reemplazar un `pending`, solicitar cancelación y hacer hasta
   tres relecturas. Sólo `cancelled`/`canceled` confirmado permite cerrar la sesión.
6. Errores, 404, identidad contradictoria, `paused`, estado desconocido o
   cancelación sin confirmar conservan la reserva y bloquean el nuevo POST.
7. Cierre condicional por sesión/negocio/estado pendiente/preapproval/referencia:
   sólo un request puede liberar la sesión. Un índice único parcial por negocio
   impide reservas paralelas incluso entre planes o ciclos distintos.
8. Un timeout/5xx al crear no demuestra que MP no creó el recurso. Se conserva la
   reserva sin ID; pasado el margen de ejecución requiere revisión de soporte.
9. No cambia el camino canónico de Recovery: sólo un pago real `approved`, con
   identidad y condiciones verificadas en el ledger, puede activar. No se borran
   pagos ni se concede acceso por correo, retorno del navegador o autorización sola.

## Archivos y alcance

| Archivos | Cambio |
| --- | --- |
| `src/pages/Plans.tsx` | Correo opcional, bloqueo síncrono de doble envío y salida a verificar pago. |
| `src/components/subscription/MercadoPagoEmailDialog.tsx` | Reutilización previa al checkout, validación, input de 16 px, botones de 44 px y footer adaptable. |
| `src/pages/SubscriptionFailure.tsx`, `src/pages/PaymentPending.tsx` | Regreso para corregir y mensajes que dependen de evidencia. |
| `src/services/subscriptionService.ts` | Documentación del contrato existente, sin persistencia ni cambio de payload. |
| `supabase/functions/_shared/billing/subscriptionActions.ts`, `store.ts` | Verificación/cancelación confirmada, reserva por negocio y cierre condicional. |
| `supabase/migrations/20261014184750_beta_mp_email_one_pending_business.sql` | Índice único por negocio pendiente; cero limpieza de datos, permisos o RLS. |
| `tests/components/betaMp/*`, `tests/unit/billingContracts.test.ts` | Casos nuevos y regresión; fixtures históricos explícitos para Recovery. |
| `tests/sql/beta_mp_checkout_authority.test.sql`, `scripts/billing/*` | Restricciones y CAS contra PostgreSQL/PostgREST reales, MP simulado. |
| `scripts/guards/beta-mp-billing-authority.mjs` | Conserva autoridad, admite la opción UX y exige cierre confirmado. |
| `.github/workflows/ci.yml` | Aísla la nueva migración en jobs que prueban etapas anteriores; billing usa el candidato completo. |
| `vercel.json` | Desactiva despliegues automáticos sólo para esta rama de PR. |

No hay rediseño general, cambios de catálogo/precios, webhook, ledger, algoritmo de
activación, POS, Mi Guita, dependencias ni contratos de facturación.

## Evidencia de validación

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
- [ ] Ejecutar `email-preflight-readonly.sql` con acceso autorizado. Si hay
  pendientes duplicados, huérfanos sin ID o contratos retirados localmente cuyo
  estado remoto no se conoce, detener la habilitación y revisar por ID. No borrar
  pagos ni cancelar contratos automáticamente para hacer pasar el índice.
- [ ] Revisar duplicados históricos antes de aplicar el índice. La migración falla
  si existen duplicados o no consigue el lock en 5 segundos; no modifica filas.
  Revisar el orden de versiones: el archivo generado el 14/10 precede al timestamp
  de Recovery del 15/10 ya presente en main. No ejecutar un push remoto ciego.
- [ ] En la ventana autorizada, coordinar la restricción de nuevas contrataciones
  mientras se instala y verifica el índice, luego actualizar `mp-subscription` y
  el frontend. No habilitar el backend nuevo sin la protección del índice.
- [ ] Verificar permisos intactos, un pendiente por negocio, reuso y reemplazo con
  proveedor simulado o entorno de pruebas; revisar las respuestas 409/502/503.
- [ ] Revisar manualmente con el proveedor la carrera entre lectura `pending` y
  cancelación: no existe una transacción compartida con MP. Las relecturas bloquean
  el reemplazo si aparece `authorized` o no se confirma la cancelación. Esta
  entrega no ejecutó ni certificó esa carrera con contratos reales.
- [ ] Autorizar por separado un negocio QA, cuenta pagadora, plan/ciclo y cualquier
  gasto/renovación antes de un smoke real con correos iguales/diferentes.
- [ ] Verificar retorno pending, primer pago aprobado en ledger y convergencia de
  webhook/reconcile sin duplicados; comprobar que autorización sola no activa.
- [ ] Monitorear rechazos y reservas bloqueadas. Un timeout sin ID puede requerir
  intervención de soporte y se bloquea deliberadamente para evitar un segundo
  recurso incierto. No resolverlo expirando filas sin evidencia remota.
- [ ] Para rollback, conservar el índice y detener nuevas contrataciones si se
  vuelve al código previo. Volver al `findOpenCheckout` anterior reintroduce el
  riesgo; no borrar pagos ni revertir estados comerciales como rollback.

Referencias consultadas: [Mercado Pago: obtener suscripción por ID](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval/get),
[gestión de suscripciones](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/subscription-management),
[PostgreSQL: índices parciales únicos](https://www.postgresql.org/docs/current/indexes-partial.html),
[Vercel: desactivar deploy por rama](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled),
[Supabase: pruebas de Edge Functions](https://supabase.com/docs/guides/functions/unit-test).
