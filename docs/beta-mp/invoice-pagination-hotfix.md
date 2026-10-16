# Hotfix: paginación de facturas de Mercado Pago

Fecha de revisión documental: 16/10/2026. Base: `main` en `cc111843`.
Fuente acotada: PR #184, `d49b3b9edf665e3ac8445439501f818042a8da57`, únicamente `listAuthorizedPayments` e `invoiceIds` y su comentario de contrato.
Este hotfix no incorpora Plan A, CLI de recuperación, RPC, migraciones ni cambios de autoridad comercial. PR #184 conserva su bloqueo independiente.

## Problema y alcance

El cliente anterior enviaba `offset=0&limit=20` y exigía que el proveedor devolviera ese tamaño.
El propietario reportó una lectura real que funciona enviando sólo `preapproval_id`; no se incluyen aquí identificadores ni respuestas privadas.
Ese reporte respalda la primera consulta y no demuestra el comportamiento de páginas posteriores.
Esta revisión no realizó consultas a Mercado Pago ni a bases productivas y no solicita ejecutar ninguna.

## Contrato de transporte y validación

- Primera GET: `/authorized_payments/search?preapproval_id=<identidad conocida por el servidor>`.
- GET posteriores: el mismo filtro y únicamente `offset=<siguiente offset validado>`; nunca `limit`, `offset=0` explícito, email, pagador, fechas ni estado.
- Se conserva el argumento histórico `limit` para compatibilidad de llamadas, pero no se envía ni determina la cobertura.
- `paging.offset`, `paging.limit` y `paging.total` deben ser enteros numéricos seguros; no se convierten cadenas a números.
- El offset debe coincidir con el solicitado; `limit` debe ser positivo y el total no puede superar 100.
- Cada página debe contener exactamente `min(limit, total - offset)` resultados, con offset no mayor que total.
- Todas las páginas deben conservar el mismo total y tamaño declarado. El siguiente offset avanza por ese tamaño del proveedor.
- Los IDs de factura admiten texto no vacío y sin espacios, o números enteros positivos seguros. `10` y `"10"` representan la misma identidad al deduplicar.
- Cada resultado debe declarar el `preapproval_id` esperado; IDs ausentes, objetos, números inseguros e identidades repetidas dentro o entre páginas bloquean la recuperación.
- Un historial vacío sólo es completo con metadata válida y total cero. La terminación exige cobertura exacta y tantos IDs únicos como el total declarado.
- El máximo de 100 facturas conserva el límite local de recuperación heredado; no representa un máximo ni un valor predeterminado documentado por Mercado Pago.
- No se impone un máximo al tamaño declarado de página: `limit: 500`, total 1 y un resultado forman una página completa válida; total 101 sigue bloqueado.

La extracción de PR #184 sólo ajusta adicionalmente ese máximo de tamaño de página: la cobertura exacta y el total acotado conservan la protección sin asumir un valor predeterminado del proveedor.

## Autoridad y errores

La búsqueda sólo enumera identidades de facturas de una suscripción que el servidor ya conoce.
No se filtra por estado: una factura pendiente, rechazada o reembolsada puede ser necesaria para interpretar la historia completa.
Los estados, fechas, importe y moneda de los resultados de búsqueda no conceden acceso.
El flujo canónico vuelve a leer cada factura y su pago por ID, valida los vínculos y términos, y sólo un pago real `approved` verificado en el ledger permite activar el plan.
Se conservan las comprobaciones existentes de fecha de aprobación, identidad local, aislamiento entre negocios e idempotencia.

La enumeración completa precede a la verificación y persistencia de pagos.
Metadata ausente, páginas cortas, total o tamaño cambiante, offset ignorado, duplicados, respuesta incompatible y errores HTTP/red abortan sin persistir un prefijo ni activar el plan.
No existe fallback automático que omita el offset, acepte la primera página como completa o intente otro filtro.
El bloqueo seguro puede impedir temporalmente recuperar un pago válido si el proveedor responde de una forma no cubierta por este contrato.

## Compatibilidad documentada y límites de evidencia

La referencia de búsqueda ilustra IDs de factura y pago numéricos, importe como cadena decimal y metadata de paginación numérica.
El SDK oficial de Node declara IDs de factura y pago como texto, importe numérico y metadata/resultados opcionales; el parser acepta ambas representaciones de identidad y conserva la validación canónica de importes.
Que un campo sea opcional en los tipos del SDK no permite inventar la metadata necesaria para acreditar cobertura completa.
La referencia muestra `limit: 20` en un ejemplo, pero no establece que ése sea el valor predeterminado universal.
Su ejemplo de total 100 con un solo resultado es ilustrativo y no constituye una página completa válida para este parser.

El SDK expone `offset` y `limit` como opciones y las reenvía al servidor; esto no certifica que la API real acepte y aplique offset en este caso.
Si offset no se acepta, la segunda página produce un error seguro. Si se ignora, se rechazan el offset devuelto o las identidades repetidas observables.
No hay evidencia disponible que garantice orden estable, snapshot entre páginas, ausencia de indexación tardía o metadata exhaustiva del proveedor.
Un total estable y resultados únicos detectan inconsistencias observables, pero no prueban que el proveedor no haya omitido una factura manteniendo metadata aparentemente coherente.
Las fechas y estados del SDK describen facturas; no cambian los criterios de acceso ni justifican inferir aprobación desde la búsqueda.

## Evidencia de pruebas

La suite dirigida cubre el formato exacto de las consultas, tamaños elegidos por el proveedor, cobertura de 100 facturas, IDs y metadata inválidos, páginas incompletas y errores posteriores.
Las regresiones deben comprobar ledger vacío, cero escrituras, acceso sin activar, sesión coherente, sólo GET y conservación del otro negocio ante cada fallo y reintento.
Los resultados ejecutados y el SHA final se registran en el PR tras completar las validaciones; este documento no certifica una corrida pendiente ni un smoke real del proveedor.

## Fuentes primarias

- [API: búsqueda de facturas](https://www.mercadopago.com.ar/developers/en/reference/online-payments/subscriptions/authorized-payment-search/get).
- [API: lectura de factura por ID](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get).
- SDK Node verificado en el commit público [`5a557def94cf546c7f7cf8d65da1e5c4b788db4b`](https://github.com/mercadopago/sdk-nodejs/commit/5a557def94cf546c7f7cf8d65da1e5c4b788db4b): [opciones y respuesta de búsqueda](https://github.com/mercadopago/sdk-nodejs/blob/5a557def94cf546c7f7cf8d65da1e5c4b788db4b/src/clients/invoice/search/types.ts), [transporte GET](https://github.com/mercadopago/sdk-nodejs/blob/5a557def94cf546c7f7cf8d65da1e5c4b788db4b/src/clients/invoice/search/index.ts), [factura](https://github.com/mercadopago/sdk-nodejs/blob/5a557def94cf546c7f7cf8d65da1e5c4b788db4b/src/clients/invoice/commonTypes.ts) y [Paging](https://github.com/mercadopago/sdk-nodejs/blob/5a557def94cf546c7f7cf8d65da1e5c4b788db4b/src/clients/commonTypes.ts). Lectura de archivos mediante el conector GitHub, sin llamadas al proveedor de pagos.
