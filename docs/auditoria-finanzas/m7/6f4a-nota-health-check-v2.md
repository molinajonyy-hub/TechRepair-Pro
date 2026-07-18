# Nota técnica para el health check v2 — mirrors históricos de anulación

**Estado: deuda de clasificación legacy, explicada y acotada. No hacer backfill ni reclasificar.**

## Qué son

Los BFE espejo que `annul_comprobante_atomic` escribe con `source='annulment'`. Hasta 6F.4, `bfe_economic_class` no reconocía ese `source`: el mirror de ingreso (`type='income'`, `category='ventas_productos'`) caía en el `ELSE` del `CASE` y quedaba como **`legacy_unclassified`**.

6F.4 agregó la rama explícita (`income` + `source='annulment'` → `revenue_collection_mirror`), pero `economic_class` la setea el trigger `trg_set_bfe_economic_class` **solo cuando es NULL**, al insertar. Las filas ya escritas conservan su clase. Deliberadamente: reclasificarlas sería un backfill sobre asientos históricos.

## Por qué NO son una alerta crítica

No afectan ningún número. `v_finance_pnl` solo suma `legacy_unclassified` dentro de `data_quality_flags.unclassified_amount`; **nunca entra en `operating_result`** ni en ninguna otra columna. Lo mismo en `v_finance_position` (`data_quality_flags`). Y desde 6F.4 la reversión devengada de venta y COGS la deriva `v_finance_sales_ledger` desde `comprobante_annulments`, no los BFE: estos mirrors son trazabilidad, no contabilidad.

Un health check que trate `unclassified_amount <> 0` como incidente va a levantar un **falso positivo crítico** en todo negocio que tenga una anulación anterior a 6F.4. Son montos negativos y de magnitud igual a las ventas anuladas, así que el falso positivo va a ser grande y llamativo.

## Qué debe hacer el health check v2

Distinguirlos antes de alertar. La condición exacta que los identifica:

```sql
source = 'annulment' AND economic_class = 'legacy_unclassified'
```

Recomendación concreta:

1. **Excluirlos** del cómputo de `unclassified_amount` que dispara alertas, o restarlos antes de evaluar el umbral.
2. **Listarlos aparte**, como "deuda de clasificación legacy explicada — mirrors de anulación anteriores a M7 6F.4", con conteo y monto por negocio.
3. **Mantenerlos fuera del operating result** — ya lo están; el check no debe "corregirlos" sumándolos a ningún bucket.
4. **No proponer backfill.** Si alguna vez se decide reclasificar, es una decisión de producto con su propio lote y su propio restatement, no un arreglo de health check.

El resto de `legacy_unclassified` (sin `source='annulment'`) **sí** es señal legítima de dato sin clasificar y debe seguir alertando.

## Cómo medirlos

`docs/auditoria-finanzas/m7/6f4-preflight-anulaciones.sql`, chequeo **F10**: devuelve conteo, monto y cantidad de negocios afectados, más el detalle fila por fila. En la base local da 0 (todas las anulaciones se crearon con la función ya parcheada).

Relacionado: F11 del mismo preflight mide las requests de anulación M6 con `request_hash` MD5 (32 hex) frente a las SHA-256 de M7 — otro residuo legacy acotado, sin impacto económico.
