# BETA-MP — recuperación excepcional de una sesión Plan A

Fecha de preparación: 16/10/2026. Rama: `codex/beta-mp-plan-a-recovery`.
Base inicial: `main` `9f27c54`; actualización incorporada por merge desde
`main` `cc11184`, preservando su CI de BETA-UX-2. Este documento describe un candidato y sus
condiciones de uso. No autoriza una lectura productiva, una migración, un
despliegue ni una intervención comercial.

> **Bloqueo productivo vigente: identidad de aplicación histórica sin resolver.**
> La aplicación del contrato histórico difiere de la integración actual. Compartir
> collector o poder leer el recurso con el token actual no demuestra qué aplicación
> lo creó ni autoriza vincularlo. Todo dry-run del caso productivo debe quedar
> bloqueado, y la RPC también debe rechazarlo. Ni cambiar variables de entorno,
> ni un recibo ni un archivo de aprobación pueden abrir esa barrera. Resolverla
> requiere evidencia primaria del proveedor y otro PR revisado con un commit
> explícito; las autorizaciones de despliegue y ejecución siguen siendo separadas.

## Alcance cerrado

Recuperar, únicamente mediante una operación administrativa autorizada por
identidad exacta, una sesión histórica Plan A que todavía no tiene
`mp_preapproval_id`. El caso admitido exige un negocio `trialing`, sin contrato
vinculado ni ledger local, y un contrato de Mercado Pago con exactamente una
factura histórica completa y un pago real `approved` verificable.

La afirmación del owner delimita el caso que se investiga; el programa debe
comprobar por API los recursos y estados y por DB las precondiciones locales.
Si no coinciden, bloquea. No selecciona contratos por correo, nombre, importe,
plan o cercanía de fechas. Tampoco vincula primero para después verificar.

La recuperación es una excepción administrativa acotada. No agrega una acción
al checkout, no amplía los permisos de los clientes y no cambia la autoridad
normal de Plan B, BETA-MP-RECOVERY o BETA-MP-EMAIL. El POS y Merchant Connect
quedan fuera de alcance.

Con referencia remota vacía y vínculo local NULL no existe una prueba automática
de pertenencia al negocio. La autorización privada debe designar explícitamente
la tupla negocio → sesión → contrato → factura → pago. La API demuestra la cadena
nativa y el pago; la decisión administrativa autoriza esa asociación concreta.
Una coincidencia de términos no reemplaza ninguna de las dos cosas.

## Tres pasos con autorizaciones separadas

| Paso | Puede hacer | Requiere antes de ejecutarse |
| --- | --- | --- |
| Preparación local | Código, tests simulados, documentación y revisión del candidato. | Alcance de desarrollo autorizado. No usar recursos reales. |
| Dry-run productivo | SELECT de la identidad autorizada y GET de sus recursos MP; generar un informe privado. | Autorización de lectura independiente sobre proyecto, negocio, sesión e IDs nativos exactos. |
| Ejecución productiva | Revalidar la evidencia y llamar una única operación DB transaccional. | Autorización comercial nueva, independiente y ligada al SHA, identidad, recibo y digest exactos; además del release y la migración autorizados. |

Que un dry-run resulte elegible no concede autorización para escribir. Aplicar
la migración tampoco autoriza una recuperación. Aprobar este documento o el PR
no habilita ningún paso productivo.

El ejecutor necesita un manifiesto privado, un recibo de dry-run de **hasta cinco
minutos** y un archivo de aprobación independiente. Una bandera de línea de
comandos, un recibo viejo o una aprobación incluida en el propio manifiesto no
sustituyen esa autorización. El manifiesto no contiene credenciales.

## Identidad y evidencia privadas

Mantener fuera de Git y del PR el manifiesto, los IDs comerciales completos, el
recibo, la aprobación y los snapshots. No pegar tokens, correos, nombres,
headers, cuerpos completos de MP ni filas de sesión en logs compartidos.
Conservar sólo resultados anonimizados en esta documentación.

El manifiesto JSON contiene exactamente seis strings: `business_id`, `session_id`,
`preapproval_id`, `preapproval_plan_id`, `invoice_id` y `payment_id`. La aprobación
del owner y la referencia de autorización se conservan por separado. El código
fija una allowlist de identidad mediante hash; no acepta otra combinación porque
sus términos parezcan similares.

El fingerprint es SHA-256 de esos seis valores en el orden anterior, unidos por
newline (`\n`), **sin newline final**, codificados en UTF-8. No calcularlo desde
JSON arbitrario ni reordenar campos a mano. La constante del candidato sólo
contiene el hash, nunca los IDs privados. El recibo y la aprobación deben
referirse al mismo fingerprint y digest de evidencia. Un cambio de identidad,
términos, evidencia o estado invalida el recibo anterior.

`application_id` y `collector_id` esperados proceden de configuración confiable
de la integración, validada de forma independiente. No se deducen del correo,
del importe ni de los valores del mismo recurso que se intenta validar. Si
faltan, el programa bloquea; no los completa automáticamente.

Para el caso actual, configurar manualmente el ID de la aplicación histórica
no resuelve la discrepancia. El token puede tener visibilidad de recursos de la
misma cuenta sin que eso pruebe que pertenecen a la aplicación actual. La
barrera de identidad permanece cerrada en código operativo y en la RPC hasta
la revisión independiente de la evidencia descrita abajo.

### Evidencia exigida para resolver la aplicación histórica

Conservar los valores completos en el expediente privado. Esta lista es un
requisito de investigación, no una autorización para consultar recursos reales:

1. Respuesta actual completa y trazable de GET del contrato y de su plan nativo,
   con IDs exactos, `application_id`, `collector_id`, fecha de creación y última
   modificación. Conservar qué cuenta y credencial autorizada efectuaron cada
   lectura, sin guardar el secreto en el informe compartido.
2. Evidencia del panel de desarrollador/cuenta del owner que identifique la
   aplicación histórica, su titular y relación con la cuenta cobradora. Distinguir
   un plan creado desde una aplicación mediante API de un plan administrado en
   el portal de Mercado Pago. Una captura con el mismo nombre comercial o
   collector no basta.
3. Trazabilidad del enlace Plan A realmente emitido: versión de código desplegada,
   plan nativo elegido por el servidor y URL entregada al checkout. El historial
   del repositorio prueba lo que el código podía hacer, no qué aplicación asignó
   MP al contrato de una operación concreta.
4. Evidencia primaria que atribuya el plan y contrato a la aplicación histórica:
   registro de creación del proveedor, metadata verificable del panel o respuesta
   de soporte MP que identifique esos recursos y explique por qué difieren de la
   integración actual. Si el panel no expone una aplicación que pueda acreditarse,
   solicitar confirmación del proveedor; no inventar una aplicación interna del
   portal ni inferir una migración de cuentas.
5. Confirmación del alcance de la credencial actual: qué cuenta y aplicación
   representa y por qué puede leer esos recursos históricos. La lectura exitosa
   sólo demuestra acceso a ese endpoint en ese momento; no prueba la aplicación
   creadora ni reemplaza los puntos anteriores.
6. Cadena actual contrato → factura → pago y autorización del owner sobre la
   identidad local exacta. La resolución de la aplicación histórica no sustituye
   las comprobaciones de pago, términos, estado o pertenencia administrativa.
7. Atribución de las notificaciones de renovación: qué aplicación emite los
   eventos de ese contrato, qué callback tiene configurado y cómo se valida su
   firma. Mostrar configuración o evidencia verificable del proveedor, sin
   divulgar secretos. Compartir collector o leer por API no demuestra que el
   webhook actual recibirá y autenticará esos eventos. No debilitar la firma ni
   aceptar otra aplicación automáticamente; si la entrega no puede acreditarse,
   la revisión posterior debe resolver una reconciliación por ID equivalente.

Si alguna prueba falta o contradice otra, conservar el bloqueo y elevar la
pregunta al proveedor. No abrir un checkout, asociar una sesión ni probar una
escritura para descubrir qué identidad acepta MP.

### Qué establecen las fuentes revisadas

La documentación oficial distingue los [planes creados desde el portal, sin
integración](https://www.mercadopago.com.ar/developers/es/docs/subscription-plans/create-subscription-plan)
de la [creación mediante API](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval-plan/post).
El primer flujo permite crear y compartir un enlace desde la cuenta; el segundo
usa una credencial y devuelve `application_id` y `collector_id`. Esa distinción
no demuestra qué aplicación asignó MP al recurso histórico de este expediente.
No se encontró en esas referencias una regla documentada que permita atribuir
un `application_id` concreto a un enlace de plan creado en el portal.

El [handler histórico Plan A de `887e812`](https://github.com/molinajonyy-hub/TechRepair-Pro/blob/887e812d832dc189674a2f82fac82c9ff5a8025c/supabase/functions/_shared/billing/subscriptionActions.ts)
lee el plan configurado y usa su `init_point` válido, o una URL alternativa con
`preapproval_plan_id`. Agrega referencia, correo y retorno; no crea el contrato
mediante `POST /preapproval` ni asigna explícitamente una aplicación al contrato.
Un `init_point` del proveedor puede conservar otros parámetros. El código por sí
solo no prueba qué URL se entregó en el request real ni cómo MP atribuyó su
aplicación creadora. No consultar secrets históricos ni reconstruir esa
identidad por semejanza: siguen haciendo falta las pruebas privadas anteriores.

## Interfaz del operador — no ejecutada en producción

El entrypoint es `scripts/billing/plan-a-recovery.mjs`. Requiere configuración
explícita, proporcionada por el circuito seguro del operador:

- `BETA_MP_RECOVERY_SUPABASE_URL`: proyecto exacto autorizado.
- `BETA_MP_RECOVERY_SERVICE_ROLE_KEY`: credencial privilegiada; no incluirla en
  el manifiesto, argumentos, recibo ni logs.
- `BETA_MP_RECOVERY_ACCESS_TOKEN`: token MP de la integración autorizada, con las
  mismas restricciones de manejo privado.
- `BETA_MP_RECOVERY_APPLICATION_ID` y `BETA_MP_RECOVERY_COLLECTOR_ID`: identidad
  confiable esperada de esa integración.

El CLI no carga `.env` automáticamente, no usa un proyecto `--linked` y no
selecciona una cuenta a partir del estado del navegador. Las rutas a archivos
privados deben ser absolutas, resolver fuera del repositorio y ser distintas
entre sí después de resolver enlaces y aliases. El candidato exige un checkout
limpio y obtiene su `sourceCommit` de Git; no lo toma del manifiesto privado.
No proporcionar ni imprimir los secretos en los
ejemplos de comandos compartidos.

Después de obtener autorización independiente de **lectura**, y desde la raíz
del checkout aprobado:

```powershell
node scripts/billing/plan-a-recovery.mjs --dry-run --case-file C:\Private\TechRepair\plan-a-case.json --receipt-file C:\Private\TechRepair\plan-a-receipt.json
```

Las rutas anteriores son ejemplos sin archivos ni datos reales. El manifiesto
no es un comando de asociación. Debe conservar el caso exacto de la allowlist;
un manifiesto sintético de pruebas no será elegible para producción.
Mientras siga sin resolver la aplicación histórica, el resultado productivo
esperado es bloqueado: no debe generarse un recibo elegible para ejecución.

Sólo después de autorizar por separado el artefacto, el release, la migración y
el commit comercial exacto, el comando futuro de ejecución agrega una aprobación
independiente al mismo caso y recibo:

```powershell
node scripts/billing/plan-a-recovery.mjs --execute --case-file C:\Private\TechRepair\plan-a-case.json --receipt-file C:\Private\TechRepair\plan-a-receipt.json --approval-file C:\Private\TechRepair\plan-a-approval.json
```

El archivo de aprobación contiene `caseFingerprint`, `evidenceDigest`,
`dryRunObservedAt`, `approvalRef`, `operatorRef`, `authorizedAt` y
`action: "execute-existing-paid-plan-a-once"`, junto con `sourceCommit`.
Su fecha debe ser posterior al
dry-run y no futura. Los campos del recibo deben coincidir exactamente y el
recibo no puede superar cinco minutos. Recibo y aprobación tienen esquemas
cerrados: no mezclar los dos en un archivo ni agregar campos. Ambos deben fijar
el mismo SHA Git completo de 40 caracteres que el artefacto en ejecución;
cambiar de commit exige otro recibo y otra aprobación.

**El archivo no es una firma criptográfica ni acredita por sí solo la identidad
del administrador.** La credencial `service_role` constituye la frontera técnica;
el operador debe verificar y conservar la autorización humana independiente
antes de crear o usar ese archivo. No autogenerarla a partir de un dry-run exitoso.

## Validaciones previas: todas obligatorias

### Estado local

- Negocio y sesión coinciden con la identidad privada autorizada; el expediente
  conserva la autorización del owner para esa asociación exacta.
- La sesión es legacy Plan A, conserva el plan nativo esperado y el preapproval
  individual todavía es NULL. Su referencia y snapshot no fueron alterados.
- El negocio sigue `trialing`, sin contrato vinculado, acceso administrativo,
  pago o ledger que contradigan el caso. Los valores deben leerse de DB.
- No existe vínculo del contrato, factura o pago con otro negocio ni otra sesión.
  No hay otra intención o historial local que requiera elegir entre contratos.
- Las restricciones de identidad de sesiones y pagos de Recovery y el índice de
  un pendiente por negocio de Email están presentes y válidos.

La antigüedad o el NULL no demuestran ausencia de un contrato remoto. Un resultado
vacío por error de lectura, permisos insuficientes o búsqueda truncada no cuenta
como una precondición verificada.

### Cadena nativa de Mercado Pago

El cliente de esta operación sólo permite GET. Debe comprobar:

1. El contrato leído por ID es exactamente el autorizado, pertenece a la
   aplicación y collector confiables, sigue `authorized` y apunta al plan nativo
   esperado por la sesión legacy. Una referencia devuelta no puede contradecir
   la sesión; no se reescribe una referencia para hacerla coincidir.
2. El plan nativo leído por su ID coincide y pertenece a esa misma integración.
   Importe, moneda y frecuencia de contrato, plan y sesión son compatibles
   mediante las reglas de términos del servidor. No usar valores actuales del
   catálogo para reinterpretar un pago histórico diferente.
3. El historial de facturas del contrato se obtuvo completo y contiene
   **exactamente una factura**, la de la identidad autorizada. Si hay otra cuota,
   intento o historia adicional, detener esta operación y abrir una revisión
   distinta; no elegir el primer pago conveniente.
4. La factura leída por ID informa el mismo `preapproval_id` y el mismo ID nativo
   de pago. Importe y moneda coinciden con la intención histórica.
5. El pago leído por su ID es el vinculado por la factura, está `approved`, tiene
   fecha de aprobación válida y términos compatibles. Contrastar los campos de
   identidad de la integración que exige el verificador; una respuesta parcial
   o contradictoria bloquea. Ni `authorized` del contrato ni `processed` de la
   factura sustituyen la aprobación del pago real.
6. Las relecturas acotadas de los recursos utilizados conservan identidad,
   estados y digest antes de declarar elegible o ejecutar. Un cambio produce
   bloqueo y requiere un nuevo dry-run.

El historial se filtra por el ID exacto del contrato, nunca por pagador o correo.
La paginación debe validar offset, límite, total, unicidad e integridad de las
páginas. Offset ignorado, páginas repetidas, total cambiante, resultados ajenos,
respuesta incompleta o exceso del límite soportado bloquean **sin persistir el
prefijo ya leído**. No cambiar de estrategia ni ampliar la búsqueda en producción
para conseguir un resultado favorable.

## Dry-run: cero escrituras

El CLI lee los recursos autorizados y ejecuta la decisión canónica sobre un
store sombra aislado en memoria. Las escrituras calculadas allí son una
propuesta, no llamadas a las tablas reales. El vínculo candidato tampoco se
escribe en DB durante esta simulación.

La barrera de sólo lectura debe abarcar:

- DB: sin INSERT, UPDATE, DELETE, RPC de commit ni eventos de auditoría remotos.
- MP: sin POST, PUT, cancelaciones, cobros, creación de contratos ni reintegros.
- UI: sin abrir checkout, pulsar «Verificar pago» o invocar `reconcile` real.

`reconcile` no es una lectura: Recovery puede escribir el ledger, cambiar el
acceso y cancelar un contrato anterior. No usarlo como herramienta de discovery.

El recibo privado debe distinguir elegibilidad de ejecución, incluir fecha de
observación, SHA del candidato, versión del protocolo, digest de identidad y de
evidencia, resultado canónico, cambios propuestos y motivos de bloqueo. No
considerar completada la recuperación porque la simulación diga `activated`.

No iniciar otro checkout para corregir un bloqueo. Preservar la reserva y
escalar por los IDs autorizados, sin reasociar, borrar o cancelar recursos.

## Ejecución futura: una transacción local

Antes de cualquier escritura, el ejecutor valida manifiesto, recibo reciente y
aprobación independiente; vuelve a consultar el conjunto completo de recursos
y exige los mismos digests y precondiciones. No ejecuta el plan guardado de forma
ciega ni acepta un patch arbitrario aportado por el operador.

El commit se realiza con `public.recover_plan_a_paid_case`, una única RPC invocada con `service_role`, declarada
`SECURITY INVOKER` y sin permiso para `PUBLIC`, `anon` o `authenticated`. Debe
aplicar una propuesta restringida producida por la autoridad canónica, no otra
regla de activación basada en un flag administrativo.

La definición candidata se entrega en
`supabase/migrations/20261016130620_beta_mp_plan_a_paid_case_recovery.sql`, posterior
a Email `20261016120000`. Su aplicación instala DDL y permisos, sin ejecutar la
recuperación ni modificar filas comerciales. Antes del release, comparar la
versión con todas las migraciones ya aplicadas y autorizar ese archivo exacto;
no ejecutar un push remoto que incluya otras migraciones.

Dentro de esa transacción:

1. Tomar bloqueos breves `SHARE ROW EXCLUSIVE` sobre sesiones, pagos y eventos,
   y bloqueos de fila sobre el negocio y la sesión. `NOWAIT` aborta ante
   contención; el candidato configura `lock_timeout = '2s'` y
   `statement_timeout = '10s'`. Los locks de tabla protegen también
   las comprobaciones de ausencia frente a inserciones concurrentes.
2. Releer y comparar el snapshot autorizado, las identidades nativas, el estado
   del negocio, la sesión NULL y la ausencia de historial incompatible. No
   sobrescribir una modificación administrativa que haya ocurrido entretanto.
3. Persistir el ledger canónico aprobado, el vínculo y consumo de esa sesión,
   el estado del negocio y la auditoría de la recuperación en la misma
   transacción. El ledger aprobado precede a la activación.
4. Exigir una sola fila en cada cambio condicional. Ante conflicto de identidad,
   snapshot distinto, timeout de lock, resultado inesperado o error, revertir
   **todo**, incluido el vínculo. No dejar un ID asociado a la espera de validar.
5. Un reintento exacto de la misma identidad y digest devuelve el resultado ya
   aplicado sin duplicar ledger o eventos. Misma identidad con otro contenido,
   o un ID nativo ocupado por otra operación, es conflicto; no se reasocia.

Los locks pueden bloquear temporalmente escrituras de billing de otros negocios.
La ejecución necesita una ventana autorizada, timeouts breves y aborto ante
contención. No mantener locks durante llamadas a MP ni reintentar automáticamente
una transacción con evidencia remota que haya quedado vieja.

Esto brinda atomicidad **local**, no una transacción distribuida con MP. El
proveedor puede cambiar después de la última lectura. Las relecturas acotadas
reducen la ventana pero no la eliminan; un cambio posterior debe converger por
webhook/reconcile canónicos. No se promete que la API pueda congelarse.

## Cuotas posteriores y verificación

Después de un commit expresamente autorizado, las notificaciones recibidas y
autenticadas usan el ID recuperado y el camino canónico existente. No permanecen habilitadas
asociaciones por correo, plan o importe. Una segunda cuota crea una nueva fila
por su identidad nativa; repetir la notificación no duplica ese pago. Rechazos,
devoluciones y contracargos conservan la autoridad de la evidencia más reciente.

La prueba de segunda cuota usa proveedor simulado: acredita el handler y su
idempotencia, no la entrega real desde la aplicación histórica. Esa entrega y
la validación de firma siguen sin certificar. Deben resolverse junto con la
identidad de aplicación antes de habilitar la recuperación; no provocar un
cobro real ni cambiar la configuración del proveedor para probarlas ahora.

La verificación posterior es una actividad separada: usar SELECT por los IDs
del expediente y comparar ledger, sesión, negocio y auditoría con el recibo.
No producir un segundo cobro de prueba. Cualquier prueba real de webhook,
reconcile, renovación, cancelación o reintegro requiere autorización propia.

## Pruebas y bloqueadores de habilitación

Evidencia local del 16/10/2026, sobre la rama aislada desde `9f27c54`:

| Validación | Resultado |
| --- | --- |
| `npm run test:beta-mp` | 680/680 Vitest, 47/47 Node; incluye 109 casos Plan A, 40 de paginación y 9 del CLI. |
| Guards y controles negativos | Billing: 114 sabotajes detectados; Plan A: 8. Cero falsos positivos. |
| TypeScript aplicación y billing | Ambos aprobados; billing se verifica con el compilador real, también en CI. |
| `npm run lint:errors` y `npm run build` | Aprobados. Build conserva la advertencia existente de tamaño de chunks. |
| PostgreSQL desechable | 77 comprobaciones Plan A: ACL, rollback en cada etapa, snapshots, conflicto real entre dos conexiones, commit sintético e idempotencia. |
| PostgreSQL/PostgREST | 82 comprobaciones aprobadas: 79 de regresión y 3 probes HTTP de la RPC (anon, authenticated y service_role con identidad sintética), sin proveedor real. |
| CLI con la identidad privada autorizada | `eligible=false`, `historical_application_identity_unresolved`, exit 2; cero peticiones MP, cero escrituras DB y ningún recibo generado. |

El CLI bloqueado se probó **sin credenciales y sin consultar producción**. No es
una revalidación del contrato, del pago o del snapshot productivo. Los commits
positivos SQL usan una identidad sintética y sustituyen allowlist/gate solamente
en la base desechable; después se restaura la definición cerrada exacta. Nunca se
abre la barrera en el archivo de migración ni en el programa operativo.

El PR debe registrar el SHA y el CI remoto de ese artefacto. La lista siguiente
permite revisar el alcance de aceptación y distinguirlo de la habilitación real:

- [ ] Dry-run elegible, bloqueado y con errores: cero escrituras DB y cero
  llamadas de modificación MP, con espías que fallen si se intenta alguna.
- [ ] Mismatch de cada ID nativo, aplicación, collector, plan, términos o fecha;
  autorización sin pago aprobado; pago rechazado/reembolsado y respuesta parcial:
  bloqueo antes de cualquier vínculo.
- [ ] Historia adicional, offset ignorado, páginas repetidas/incompletas,
  resultados ajenos y total cambiante: bloqueo sin ledger parcial.
- [ ] Recibo vencido, identidad o digest distinto, aprobación ausente, mezclada
  con el manifiesto o para otro artefacto: ejecución rechazada.
- [ ] Rollback real local con fallo inyectado en ledger, vínculo, negocio y
  auditoría: ningún cambio persiste en ninguna tabla.
- [ ] Concurrencia, reintento exacto, conflicto entre negocios y cambio de
  snapshot/override administrativo: no sobrescribir ni duplicar.
- [ ] Futuro segundo cobro por el handler canónico y notificación repetida:
  ledger único y acceso sólo con evidencia aprobada verificable.
- [ ] Regresión completa de Plan B, Recovery y Email, incluidas las reservas
  NULL aisladas, el checkout directo y la ausencia de cancelación automática.
- [ ] ACL de la RPC, índices de identidad, timeouts y locks comprobados contra
  PostgreSQL/PostgREST desechables; acceso anónimo/autenticado rechazado.
- [ ] Verificación estática, tests, SHA del artefacto y CI documentados sin
  omisiones presentadas como pruebas aprobadas.

El bloqueador actual es la discrepancia de aplicación histórica sin prueba del
proveedor. La confirmación comercial del owner sobre la identidad exacta ya fue
recibida; no resuelve esa procedencia técnica. Este candidato no revalidó los
recursos productivos mediante API y no generó un recibo elegible.

Además, el flujo futuro debe bloquear si falta configuración confiable, una
precondición local no coincide, no hay recibo reciente/aprobación independiente,
la RPC no fue instalada mediante un release autorizado o los locks encuentran
contención. Ninguna de esas condiciones se resuelve automáticamente.

## Referencias primarias

- [MP: obtener contrato por ID](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval/get).
- [MP: obtener plan nativo por ID](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-preapproval-plan/get).
- [MP: creación de planes desde la cuenta, sin integración](https://www.mercadopago.com.ar/developers/es/docs/subscription-plans/create-subscription-plan).
- [MP: creación de planes mediante API](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/create-preapproval-plan/post).
- [MP: obtener factura autorizada](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get).
- [MP: buscar facturas del contrato identificado](https://www.mercadopago.com.ar/developers/en/reference/online-payments/subscriptions/authorized-payment-search/get).
- [MP: obtener el pago real](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-payment/get).
- [SDK oficial Node.js de Mercado Pago](https://github.com/mercadopago/sdk-nodejs).
- [PostgreSQL: locks explícitos](https://www.postgresql.org/docs/current/explicit-locking.html).
- [Autoridad canónica y limitaciones de Recovery](recovery-runbook.md).
- [Auditoría de la reserva NULL e aislamiento](email-reservation-audit.md).
