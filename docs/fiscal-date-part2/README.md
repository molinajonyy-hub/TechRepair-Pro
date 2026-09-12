# FISCAL DATE ARGENTINA — Parte 2

Persiste la fecha fiscal **exacta** (`CbteFch`) que ARCA aceptó, en una columna
canónica nueva. La Parte 1 arregló *qué fecha se manda*; la Parte 2 arregla *que
esa fecha quede guardada y se pueda mostrar*.

Hasta acá no existía ningún lugar donde estuviera: `fecha_emision_fiscal` es el
instante de **completado** (`now()`), `fecha` es la **fecha de venta**, y ni
`request_data`, ni `response_data`, ni `electronic_invoice_log` guardaban
`CbteFch`.

## El invariante que manda

> **El CAE vale más que la metadata.**

Ninguna fecha ausente, malformada o imposible (`20260231`), ni un fallo al
escribir la columna, puede impedir que se persista un CAE ya autorizado, ni
crear un `pending_reconciliation` nuevo. La persistencia de la fecha vive en
sub-bloques con `EXCEPTION` propio (savepoints implícitos), **después** del
completado canónico. Probado en `tests/sql/fiscal_date_part2.test.sql` C1–C9.

El invariante hermano:

> **Nunca se inventa una fecha fiscal.**

Si no se conoce, queda `NULL` y la UI dice «No informada». La fecha de venta
**no** es un reemplazo: puede diferir un día, que es exactamente el problema que
originó esta fase.

## Qué cambia

| Pieza | Cambio |
|---|---|
| `comprobantes.fecha_comprobante_fiscal` | columna `date` nueva, aditiva y nullable |
| `arca_parse_cbte_fch(text) → date` | parser defensivo que **nunca** lanza (`make_date`, no `to_date`) |
| `trg_comprobante_fiscal_date_immutable` | `NULL→fecha` sí, `fecha→misma` idempotente, `fecha→otra` bloqueado (`55006`) |
| `complete_arca_attempt` | identidad de 7 → 8 argumentos (`p_fecha_cbte text DEFAULT NULL`), reemplazo **atómico** |
| `afip-cae` | manda el mismo `CbteFch` que puso en `FECAESolicitar`; usa el que ARCA reporta cuando reconcilia un intento anterior |
| UI | «Fecha de emisión» sólo desde la columna nueva; «Fecha de venta» sigue siendo la venta |

`p_fecha_cbte` es **text** a propósito: con `date`, PostgREST podría rechazar o
castear un valor inválido *antes* de entrar a la función, y un CAE ya autorizado
se perdería por metadata.

## Orden de despliegue

1. **DB primero.** Con `p_fecha_cbte DEFAULT NULL`, el `afip-cae` viejo (que
   manda 7 argumentos) sigue resolviendo contra la función de 8. Probado por
   HTTP real contra PostgREST: `scripts/fiscal-date-part2/postgrest-signature-gate.mjs`.
2. **Después el Edge.** A partir de ahí las fechas nuevas se persisten solas.
3. Backfill del histórico: **paso aparte**, con autorización propia.

### Rollback

1. Volver **primero** el Edge a la versión previa (manda 7 argumentos). Ese paso
   no depende del SQL.
2. Sólo si hace falta, correr `docs/fiscal-date-part2/rollback.sql`, que
   restaura la definición de 7 argumentos **exacta** que corría en producción
   (`md5(prosrc) = 3b3b33da91367df6b8726f3160bd82cb`; ojo: **sin** el comentario
   `-- idempotente` que sí está en la fuente del repo y en las DB locales).
3. **La columna no se dropea**, y el trigger tampoco: conservan historia fiscal
   que no se puede reconstruir localmente, y son inertes para un llamador viejo.

## Estado del histórico (producción, sólo lectura, 2026-09-12)

De 178 comprobantes autorizados:

| Clase | N | Por qué |
|---|---:|---|
| `PROVABLE_LOCAL` | 128 | el día UTC y el día civil AR del `sent_at` coinciden |
| `REQUIRES_ARCA_LOOKUP` | 50 | 48 sin `sent_at` + 2 enviados en la ventana 21:00–23:59 ART |
| `INCONSISTENT` | 0 | — |

**Por qué «UTC = AR» alcanza como prueba.** Antes de la Parte 1 el `CbteFch`
salía de una fecha calculada en UTC (el navegador con
`toISOString().slice(0,10)`, y el Edge con su `todayYYYYMMDD()`, también UTC).
Desde la Parte 1 lo decide el día civil argentino. Para un instante de envío hay
entonces tres fórmulas candidatas, y **cuando el día UTC y el día civil AR
coinciden, las tres dan el mismo valor**: ahí el `CbteFch` queda determinado sin
necesidad de saber qué build estaba desplegado. Cuando difieren, el valor depende
de la versión y hay que preguntarle a ARCA.

Los 2 de la ventana son los casos donde el bug realmente pegó:

| Comprobante | UTC (lo que probablemente registró ARCA) | día civil AR |
|---|---|---|
| `0010-00000087` | 2026-07-18 | 2026-07-17 |
| `0010-00000138` | 2026-08-09 | 2026-08-08 |

La clave de consulta se deriva localmente para los 50: PV y número salen de
`numero_fiscal` (**no** de la columna `punto_venta`, que en parte del histórico
conserva su default `'0001'` mientras el número fiscal dice `0010-…`), y el
`CbteTipo` sale de `tipo` cuando `tipo_comprobante_fiscal` es `NULL` (46 de 50).
Sin `CbteTipo`, `numero_fiscal` es **ambiguo**: hay un `0010-00000001` factura y
otro nota de crédito.

## Herramientas

Se versionan las herramientas; **sus salidas no** (llevan datos fiscales reales,
ver `.gitignore`).

| Script | Qué hace | Ejecuta algo? |
|---|---|---|
| `run-sql-tests.mjs` | regresión SQL en una transacción que termina en `ROLLBACK` | sí, sólo local |
| `postgrest-signature-gate.mjs` | hard gate de resolución de firma por HTTP; restaura la base local y lo verifica por `md5` | sí, sólo local |
| `classify-historical.sql` / `.mjs` | clasifica el histórico; un único `SELECT`, con guardia que aborta si aparece una sentencia de escritura | sólo lectura |
| `plan-arca-lookup.ts` | arma el plan de `FECompConsultar` y su SHA-256 | **no** — no abre red |
| `generate-backfill.mjs` | genera el `.sql` de backfill y su SHA-256 | **no** — no abre base |

`plan-arca-lookup.ts` reusa `buildFECompConsultarSOAP` y
`parseFECompConsultarResponse` de `afip-cae`: el mismo builder y parser
certificados que corren en producción, para que el plan no sea una segunda
implementación que pueda divergir. La única operación WSFEv1 que arma es
`FECompConsultar`; el builder de `FECAESolicitar` no se importa siquiera.

El backfill generado es idempotente y no puede pisar historia: cada `UPDATE` es
por `id` y exige `cae IS NOT NULL AND fecha_comprobante_fiscal IS NULL`. Cada
fila lleva su **procedencia** en un comentario. Una fecha de ARCA que no tenga
forma `YYYYMMDD` se **descarta con aviso**, nunca se corrige.
