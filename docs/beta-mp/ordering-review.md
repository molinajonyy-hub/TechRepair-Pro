# PR #179 — pagos fuera de orden

Base revisada: `050eb0bdb028fe54225e70fc69709a21a9ac3ddb`, con 14/14 checks
verdes. La revisión encontró una regresión que esos checks no cubrían.

## Reproducción y diagnóstico

La prueba `una segunda cuota aprobada notificada después del rechazo de la tercera
no levanta la mora` ejecuta el código real de billing con API de MP simulada:

1. Primera cuota aprobada y negocio activo.
2. Segunda cuota aprobada en MP, todavía sin webhook.
3. Tercera cuota rechazada y notificada: negocio en `past_due`.
4. Llega la notificación de la segunda cuota.

En la base, la prueba falla: `last_payment_id` pasa de la tercera cuota a la
segunda, `last_payment_status` de `rejected` a `approved`, el estado vuelve a
`active`, la gracia se borra y el período avanza a la segunda cuota.

La causa es `recoverPayments(..., onlyInvoiceId)`: la colección considerada por
`applyToBound` contiene sólo esa factura. Se convierte en `latest`, y
`freshApproval` da true porque la fecha de su aprobación es posterior al inicio
de la primera cuota. El timestamp del preapproval no ordena cuotas; la escritura
condicional tampoco corrige una decisión cronológica equivocada.

## Corrección

Las decisiones de acceso recuperan el contrato completo, con los mismos límites,
validaciones financieras e identidad del servidor que reconcile. Agregan dos
pistas que nunca aportan estado por sí mismas:

- La factura notificada, aunque todavía no esté indexada en la búsqueda.
- La identidad del último pago guardado por el servidor: permite encontrar su
  factura en el ledger y releer **factura y pago en MP** si la búsqueda los omite.

La pista local debe pertenecer al negocio y al preapproval correctos, con el ID
de factura coherente. Si el último pago no puede verificarse, se conserva el
estado y se devuelve `payment_link_mismatch`; no se infiere aprobación.

La selección compartida de `latest` ignora cuotas programadas/pending sin estado
definitivo y usa las fechas verificadas ya empleadas por el proyecto. Un rechazo
vence una aprobación con el mismo instante, independientemente del orden de
búsqueda. La evidencia definitiva sin fecha comprobable bloquea la decisión con
`payment_missing_event_date`. La política comercial existente de pagos cancelados
no se redefine.

Ahora, con el tercer rechazo como `latest`, `freshApproval=false`.
`paymentFailure=true` conserva `past_due`, el último rechazo, el período y la
gracia. Una cuarta cuota efectivamente posterior y aprobada sí permite recuperar
el acceso. El reintento por escritura concurrente vuelve a consultar el contrato.

La primera activación aplica el mismo criterio completo. El modo de una factura
se conserva para ledger histórico sin decisiones de acceso. El Plan A sin
identidad local continúa rechazado como `unknown_preapproval`.

## Evidencia

Comando reproducible del escenario específico:

```bash
npx vitest run --config vitest.config.ts tests/components/betaMp/betaMpWebhook.test.ts -t "segunda cuota aprobada notificada"
```

Resultado antes del arreglo: una prueba fallida; después del arreglo: pasa.
La suite de webhook pasa 33 pruebas; el conjunto de billing pasa 474.
También pasan 33 contratos Node, guard de autoridad y sus 99 controles negativos,
check de los siete módulos compartidos y lint del helper de evidencia.
La matriz aislada de PostgreSQL/PostgREST pasa 67 comprobaciones, con MP simulado.

Las regresiones nuevas comprueban snapshots del negocio, período/gracia y otro
tenant; notificación duplicada y otra notificación del mismo recurso; reconcile
posterior; aprobación nueva que sí levanta la mora; rechazo antiguo frente a
aprobación posterior sin webhook; búsqueda que omite el último pago o la factura
notificada; empates en ambos órdenes; fechas ausentes; pista local perdida;
lectura fallida/reintento; carrera de escritura; y primera activación con una
cuota programada futura que no debe ocultar el rechazo.

## Límites y recomendación

Cada notificación que puede decidir acceso consulta ahora las facturas del
contrato, por lo que aumenta la cantidad de lecturas y la latencia. La búsqueda
sigue limitada a 100 facturas; los IDs notificado/conocido se agregan como pistas
exactas cuando faltan en esa búsqueda. Una historia que exceda el límite o una
lectura fallida preserva el estado y deja el evento reintentable; una contradicción
de identidad/fecha impide aplicar acceso hasta verificarla. No se amplía el límite
ni se agrega una migración en esta revisión.

Recomendación de código: mergear el nuevo SHA únicamente con sus checks verdes.
La corrección no certifica MP en producción: sigue pendiente la correspondencia
privada del 401 y el smoke autorizado del [runbook](recovery-runbook.md).
No se hicieron merge, deploy, migraciones remotas, cancelaciones/pagos reales ni
modificaciones comerciales.
