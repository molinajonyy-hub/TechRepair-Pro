# Charts L1 — P1 registrados

> **Estado: CERRADOS** en la rama `fix/prebeta-finance-p1-closure` (lote pre-beta
> de cierre de P1). Este archivo queda como registro del diagnóstico y de la
> decisión tomada en cada uno. Los dos P1 originales se numeraron **P1-A** y
> **P1-B** acá; en el lote de cierre pasaron a llamarse **P1-B** y **P1-C**
> respectivamente, para dejarle **P1-A** al bug de layout móvil de Finanzas →
> Caja. Se anota la equivalencia en cada sección para que no se pierda el hilo.

---

## P1-A *(= P1-B del lote de cierre)* — `v_finance_position.inventory_at_cost` excluía padres de variante con una regla incompleta

**Estado:** ✅ cerrado — migración `20260810130000_finance_position_variant_parent_alignment.sql`.

`v_finance_position` (migración `20260704120000_canonical_views.sql`) excluía los
productos-padre así:

```sql
AND NOT EXISTS (
  SELECT 1 FROM inventory v
  WHERE v.business_id = i.business_id
    AND v.supplier_code = 'VPREF-' || i.id::text)
```

Es decir, **sólo por la convención `VPREF-`**. Pero el modelo admite dos formas
de vincular una variante a su padre:

| convención | filas en producción (2026-08-10) |
|---|---|
| `inventory.parent_id` | 0 |
| `inventory.supplier_code = 'VPREF-<parent_id>'` | 0 |

`v_finance_inventory_capital` (Charts L1) excluye por **las dos**.

**Por qué no se notaba:** ambas reglas daban el mismo total. Verificado sobre
producción el 2026-08-10, negocio por negocio: **delta = 0,00 en los 5 negocios
con inventario**. Hay 23 productos con `has_variants = true`, pero es una bandera
huérfana: no existe ninguna fila-variante.

**Qué habría pasado:** el día que alguien creara una variante vía `parent_id`,
`v_finance_position.inventory_at_cost` habría sumado **el padre y la variante**
(double-count) mientras Charts L1 sumaba sólo la variante. Dos números de
inventario distintos en la misma app, sin que nada fallara.

### Cómo se cerró

**No** se copió el predicado corregido a `v_finance_position`: copiarlo deja dos
lugares que pueden volver a divergir, que es exactamente el defecto. El CTE `inv`
pasa a **leer `v_finance_inventory_capital`**, que ya es la superficie canónica
de la valuación. Queda una sola definición en todo el sistema.

**Regla canónica** (documentada en la migración): una fila de `inventory` aporta
a la valuación si, y sólo si, está activa, es `tipo='product'`, y **no** es un
padre agrupador — o sea, no existe **en su mismo negocio** otra fila que la
declare padre por *ninguna* de las dos convenciones. La pertenencia al mismo
`business_id` se exige en las dos ramas: un `supplier_code` que casualmente diga
`VPREF-<uuid ajeno>` no puede excluir un producto de otro negocio.

**Diferencia que se conserva a propósito:** `v_finance_inventory_capital` publica
dos totales que **no** son sinónimos. `inventory_at_cost` es el universo con
stock (incluye costo 0 y stock negativo); `inventory_at_cost_valued` filtra
`stock>0 AND costo>0` porque comparte denominador con la regla `dead_stock` de
M8. `v_finance_position` se alinea con el **primero**, que tiene su misma
definición. Igualarlo al segundo escondería el stock sin costo y el negativo.
Testeado en `tests/sql/prebeta_p1_closure.test.sql` B14.

---

## P1-B *(= P1-C del lote de cierre)* — `comprobantes.estado_fiscal` tenía un DEFAULT que su propio CHECK rechazaba

**Estado:** ✅ cerrado — migración `20260810140000_comprobantes_estado_fiscal_default_contract.sql`.

```
columna : estado_fiscal
DEFAULT : 'borrador'
CHECK   : estado_fiscal = ANY (ARRAY[
            'no_fiscal', 'pendiente_emision', 'pendiente_conciliacion',
            'emitido', 'error_emision', 'anulado_fiscal'])
```

`'borrador'` **no estaba** en la lista permitida. Cualquier `INSERT` que no
seteara `estado_fiscal` explícitamente fallaba con
`comprobantes_estado_fiscal_check`.

**Cómo se descubrió:** al escribir los fixtures de
`tests/sql/finance_charts_l1.test.sql`, que insertan comprobantes directo.

**Por qué no explotaba en producción:** los caminos vivos setean la columna
explícitamente, así que el DEFAULT nunca se usaba. Era una bomba con el pin
puesto: la armaba cualquier `INSERT` nuevo que lo omitiera.

### Cómo se cerró

Se corrigió el **DEFAULT**; el CHECK **no** se tocó.

La evidencia dice que `'borrador'` es un default legacy copiado de la columna
vecina `estado`, no un estado del dominio fiscal:

* producción, 318 comprobantes: `'borrador'` en **0 filas**, `NULL` en **0**;
* el tipo del frontend (`comprobanteService.EstadoFiscal`) enumera los 6 valores
  del CHECK y no incluye `'borrador'`;
* el `COMMENT` de la columna documenta los 6 y no lo menciona;
* la columna `estado` —el estado **documental**— tiene DEFAULT `'borrador'` y un
  CHECK que sí lo admite, y el checkout canónico escribe las dos en la misma
  sentencia:
  `estado := es_fiscal ? 'borrador' : 'emitido'` /
  `estado_fiscal := es_fiscal ? 'pendiente_emision' : 'no_fiscal'`.

**Valor elegido: `'no_fiscal'`.** El estado inicial canónico depende de si el
comprobante es fiscal, y un DEFAULT de columna no puede leer otra columna, así
que tiene que ser el valor seguro. `es_fiscal` ya tiene DEFAULT `false`: una fila
que se apoya en los defaults queda `es_fiscal=false` + `estado_fiscal='no_fiscal'`,
que es coherente. `'pendiente_emision'` habría anunciado un comprobante como
pendiente de ARCA sin que nadie lo pidiera.

**Riesgo residual declarado:** la columna sigue siendo `NULLABLE`, y un CHECK se
satisface con `NULL`. Un `INSERT` con `estado_fiscal => NULL` explícito lo
atraviesa. Hoy no hay ninguna fila `NULL` en producción y ningún escritor manda
`NULL`. Cerrarlo pide un `NOT NULL`, que es un endurecimiento de esquema con su
propio riesgo sobre la emisión ARCA: no entra en un lote de cierre de P1.

---

## Lo que además se cerró en el mismo lote

* **P1-A (nuevo)** — Finanzas → Caja usaba `repeat(4, 1fr)` y `repeat(3, 1fr)`
  fijos: en 390px el grid superaba el viewport y `body { overflow-x: hidden }`
  recortaba tarjetas monetarias **sin scrollbar**. Corregido con
  `auto-fit + minmax`, `minWidth: 0` y scroll propio para la tabla de
  movimientos. Gate visual: `tests/e2e/m7/finance-caja-visual.spec.ts`.
* **P1-D** — la reposición pasó a llamarse **"Reposición registrada"** y un 0 %
  ahora se explica ("No se registraron entradas de mercadería en inventario
  durante este período") en vez de leerse como "no compré mercadería". La
  fórmula **no** cambió. Migración `20260810150000` agrega
  `supplier_purchases_count/_amount` como **contexto** del período — nunca como
  numerador.

Guard del lote: `scripts/finance/guard-prebeta-p1.mjs` (`npm run guard:prebeta-p1`).
