# Charts L1 — P1 registrados (NO se corrigen en este lote)

Ambos hallazgos salieron del trabajo de Charts L1 y están **fuera de su
alcance**. Se registran acá para que no se pierdan y para que quede explícito
que se decidió no tocarlos ahora.

---

## P1-A — `v_finance_position.inventory_at_cost` excluye padres de variante con una regla incompleta

**Estado:** latente. Hoy **no** hay divergencia; la habrá con la primera variante real.

`v_finance_position` (migración `20260704120000_canonical_views.sql`) excluye los
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

**Por qué hoy no se nota:** ambas reglas dan el mismo total, verificado sobre
producción — `37.906.051,76` con una y con otra. Hay 23 productos con
`has_variants = true`, pero es una bandera huérfana: no existe ninguna
fila-variante.

**Qué pasa cuando se rompe:** el día que alguien cree una variante vía
`parent_id`, `v_finance_position.inventory_at_cost` va a sumar **el padre y la
variante** (double-count) mientras Charts L1 suma sólo la variante. Dos números
de inventario distintos en la misma app, sin que nada falle.

**Por qué no se corrige acá:** `v_finance_position` es superficie auditada en M7
y consumida por `finance_dashboard_summary`. Cambiarla mueve un número en
producción, que es exactamente lo que este lote se prohibió hacer.

**Cómo se cierra:** una migración forward-only que alinee el predicado de
`v_finance_position` con el de `v_finance_inventory_capital` (excluir por
`parent_id` **o** `VPREF-`), con dry-run que demuestre delta = 0 antes de
aplicar. Idealmente extrayendo el predicado a un solo lugar para que no puedan
volver a divergir.

---

## P1-B — `comprobantes.estado_fiscal` tiene un DEFAULT que su propio CHECK rechaza

**Estado:** defecto real, pre-beta. Preexistente a Charts L1.

```
columna : estado_fiscal
DEFAULT : 'borrador'
CHECK   : estado_fiscal = ANY (ARRAY[
            'no_fiscal', 'pendiente_emision', 'pendiente_conciliacion',
            'emitido', 'error_emision', 'anulado_fiscal'])
```

`'borrador'` **no está** en la lista permitida. Cualquier `INSERT` que no setee
`estado_fiscal` explícitamente falla con
`comprobantes_estado_fiscal_check`.

**Cómo se descubrió:** al escribir los fixtures de
`tests/sql/finance_charts_l1.test.sql`, que insertan comprobantes directo.

**Por qué no explota en producción:** los caminos vivos (`comprobanteService`,
las RPC de checkout) setean la columna explícitamente, así que el DEFAULT nunca
se usa. Es una bomba con el pin puesto: la arma cualquier `INSERT` nuevo que lo
omita — un script de migración de datos, un fixture, una RPC futura.

**Por qué no se corrige acá:** tocar el esquema de `comprobantes` no tiene nada
que ver con visualizaciones financieras, y hacerlo dentro de Charts L1
mezclaría dos cosas que deben revisarse por separado.

**Cómo se cierra:** migración forward-only que cambie el DEFAULT a un valor
válido (`'no_fiscal'` es el candidato natural: es lo que usan los comprobantes
no fiscales) **o** que agregue `'borrador'` al CHECK si resulta que es un estado
legítimo del dominio fiscal. Decidir cuál de las dos requiere mirar la máquina
de estados de ARCA — por eso no se resuelve de apuro.

**Mientras tanto:** todo `INSERT` directo sobre `comprobantes` debe setear
`estado_fiscal` explícito. Los fixtures de Charts L1 ya lo hacen y lo documentan
en el propio archivo.
