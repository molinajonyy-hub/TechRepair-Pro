# P0-A — Informe final de release

**Fecha:** 2026-07-30 · **Estado: DESPLEGADO EN PRODUCCIÓN Y VERIFICADO**
Baseline previo: `main` = f3a492f · prod = 205 migraciones · Health Check critical = 0
Estado actual: `main` = **4675ab6** · prod = **206 migraciones** · Health Check critical = **0**

P0-B **no ejecutado**. Órdenes históricas **no modificadas**. **Sin tag**. Los dos P1 **no mezclados**.

---

## 1. Secuencia ejecutada

| # | Paso | Resultado |
|---|---|---|
| 1 | Publicar rama | `fix/p0a-order-cogs-absorbed` → origin ✅ |
| 2 | Abrir PR | [#29](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/29) ✅ |
| 3 | CI y Vercel | TypeScript+Lint+Build **pass** · Vercel **pass** · E2E Smoke *skipping* ✅ |
| 4 | Merge commit | `4675ab653953fa6710df52eca2b427509ad93b82` · 2026-07-30 13:39:34Z ✅ |
| 5 | Migración 206 | `20260730120000_p0a_order_cogs_gap_detector.sql`, **la única pendiente** ✅ |
| 6 | Verificar DB + Health Check | critical **0** ✅ |
| 7 | Desplegar frontend | Vercel Production `ref=4675ab6539` **success** ✅ |
| 8 | Smoke productivo | app OK · bundles verificados · cero escrituras ✅ |

## 2. Migración aplicada

Dry-run previo confirmó **una sola** migración pendiente; el resto local == remoto.

```
Would push these migrations:
 • 20260730120000_p0a_order_cogs_gap_detector.sql
```

Aplicada sin errores. Verificación post-aplicación en la base viva:

| Comprobación | Resultado |
|---|---|
| Migraciones en prod | **206** |
| `v_finance_order_cogs_gaps` existe | sí (`relkind = v`) |
| `reloptions` | `{security_invoker=true}` |
| Grants | `authenticated:SELECT`, `service_role:SELECT` |
| Grants a `anon` | **0** |
| Check `canonical_views_without_security_invoker` | **0** — la vista nueva pasa el control de aislamiento contra la base viva |

## 3. Health Check productivo

Ejecutado con el rol real (`authenticated` + `sub` del owner), negocio `aa930802…`:

```
ok = true · critical = 0 · warning = 5 · low = 2 · total_issues = 28
```

**critical = 0**, igual que el baseline. `pnl_vs_ledger_mismatch` = 0 (P&L y ledger coinciden).

Los 5 warnings y 2 low son **preexistentes** — ninguna escritura ocurrió en esta release:

| Check | n | Nota |
|---|---|---|
| `cash_without_caja` | 10 | preexistente |
| `service_with_cogs` | 12 | preexistente — **ver §6, cambia de significado** |
| `header_vs_live_payments` | 2 | preexistente |
| `annulment_without_audit_event` | 1 | preexistente |
| `inventory_movement_orphan` | 1 | preexistente |
| `credit_note_without_physical_return` | 1 | low, semántica esperada (7C) |
| `reconciliation_corrected` | 1 | low, rastro de la reconciliación 7B |

## 4. Estado inicial del detector canónico en producción

Primera lectura de `v_finance_order_cogs_gaps` sobre datos reales:

| `gap_type` | Severidad | Órdenes | Monto ARS |
|---|---|---|---|
| `orden_sin_comprobante_vinculado` | critical | 30 | 897.202,50 |
| `cogs_incompleto` | critical | 3 | 136.560,00 |
| `orden_sin_comprobante_vinculado` | warning | 1 | 45.000,00 |
| `snapshot_de_costo_faltante` | warning | 3 | 0,00 |
| `riesgo_doble_stock` | — | **0** | — |

Esto es la **fotografía del pasado**, no un defecto nuevo: es exactamente la deuda que P0-B tiene que reconciliar. `riesgo_doble_stock` en **0** confirma que no hay ninguna línea que pueda descontar stock por segunda vez.

> El monto de `orden_sin_comprobante_vinculado` (897.202,50) es **mayor** que la exposición de COGS de repuestos (730.162,50) porque incluye también costos internos de servicio que en muchos casos **sí** se reconocieron, en un comprobante que quedó sin `order_id`. No es un pasivo adicional: es la medida de la deuda de trazabilidad. El número inequívoco para P0-B sigue siendo **730.162,50**.

## 5. Smoke productivo controlado

**Deliberadamente sin transacciones de prueba.** Crear un comprobante real en producción contaminaría el libro contable que este mismo P0 protege; no lo hice y no lo haría sin autorización explícita. El smoke fue: verificación read-only de la base + verificación del artefacto desplegado.

**a) La base no se movió.** Antes y después del release:

```
comprobantes 277 · comprobante_items 458 · order_items 75
inventory_movements 413 · financial_movements 302 · business_finance_entries 441
ventas 15.217.295,80 · COGS 5.776.971,03 · resultado 6.830.910,12
```

Cero escrituras. La release fue puramente estructural.

**b) La app carga.** `https://techrepairpro.app` responde, renderiza la pantalla de acceso y **no emite ningún error de consola**. No inicié sesión: no ingreso credenciales.

**c) El bundle desplegado contiene el fix** — verificado descargando los chunks reales desde el dominio productivo:

`/assets/OrderDetail-BzRq0lYc.js` (80.157 bytes)

| Símbolo | Presente |
|---|---|
| `absorbedCostArs` | ✅ |
| `unrecognizedCostArs` | ✅ |
| `foldedIntoIndex` | ✅ |
| `roundingDeltaArs` | ✅ |
| `billableFromOrderItems` (armado viejo) | **ausente** ✅ |

`/assets/Comprobante-DmdtioQv.js` (49.047 bytes)

| Símbolo | Presente |
|---|---|
| «sin costo registrado» (texto nuevo) | ✅ |
| «sin costo registrado (servicios)» (texto viejo) | **ausente** ✅ |
| `cost_price` (lectura de inventario vivo) | **ausente** ✅ |

El motor de rentabilidad paralelo que releía `inventory.cost_price` ya no existe en el artefacto productivo.

## 6. Hallazgo del release: `service_with_cogs` quedó semánticamente obsoleto

El Health Check tiene un check `service_with_cogs` — *«N línea(s) de servicio con costo de mercadería»* — que hoy marca **12 casos como warning**.

Con la decisión contable autorizada (**«un repuesto consumido para prestar una reparación es COGS aunque esté incluido dentro del precio total del servicio»**), una línea de servicio con COGS pasó de ser una anomalía a ser **el resultado correcto y deliberado** de la estrategia A.

**Consecuencia operativa: este warning va a crecer** con cada orden que se facture con repuestos absorbidos. **No indica un defecto.**

No lo modifiqué, por dos razones: quedaba fuera del alcance autorizado, y `finance_health_check_v2` es una función de ~700 líneas cuyo reemplazo completo para reinterpretar un check es un riesgo desproporcionado. Queda registrado como lote de seguimiento: reinterpretar `service_with_cogs` (por ejemplo, excluir las líneas de comprobantes con `order_id`, que ahora son legítimas) y, en el mismo lote, integrar `v_finance_order_cogs_gaps` al panel de Health Check.

## 7. E2E Smoke en CI: falla preexistente, no causada por esta release

El job **E2E Smoke Tests** falla en `main` con:

```
No se pudo determinar el destino: VITE_SUPABASE_URL está vacía o ausente en el modo e2e.
Fail-closed: se aborta en vez de arriesgar una escritura en producción.
```

Es el **guard fail-closed de 7D.2 funcionando como debe**: CI no tiene `VITE_SUPABASE_URL` configurada y el harness prefiere abortar antes que arriesgar una escritura contra producción. El mismo job falló idénticamente en los merges **#27** (2026-07-28) y **#28** (2026-07-29), ambos anteriores a este cambio. En el PR el job aparece como *skipping*.

**No es una regresión de P0-A.** Es deuda de configuración de CI: el E2E está pensado para correr en local contra el stack de Docker. Queda registrado, sin mezclarlo con este lote.

## 8. Qué cambia desde ahora

- Toda orden que se facture desde el detalle de la orden lleva **`order_id`** en el comprobante.
- El costo de los repuestos consumidos —incluidos los absorbidos por el precio del servicio— se reconoce como **COGS en la misma fecha económica que el ingreso**.
- **«Ganancia real hoy» va a bajar ~6 %** respecto de lo que venía mostrando. No es una regresión: es el costo que antes faltaba.
- El total cotizado al cliente **no cambia** y ningún documento al cliente muestra costos.
- El stock se descuenta **una sola vez**, al agregar el repuesto a la orden.

## 9. Lo que NO se hizo

- **P0-B no ejecutado.** El backfill de 730.162,50 ARS sigue diseñado, con dry-run, sin correr.
- **Ninguna orden histórica modificada.** Ninguna fila financiera tocada.
- **Sin tag.**
- **P1 no mezclados**: (1) las líneas de producto normales siguen resolviendo el costo desde el inventario vivo al facturar; (2) `orders.total_cost` sigue conteniendo costos y no precios, con `ModalCobro` —código muerto— cobrando ese campo.
- Sin recorrido de UI autenticado: no ingreso credenciales en producción.

## 10. Estado final y recomendación

**Release cerrada y verificada.** Riesgo residual bajo: no se modificó ninguna RPC, ningún trigger ni ninguna vista del motor contable; la única migración es una vista aditiva y read-only.

Próximos pasos sugeridos, **cada uno como lote propio**:

1. **Observar 24-48 h** el detector y el resultado diario. La primera orden con repuesto absorbido que se facture debería aparecer con COGS y sin hueco.
2. **P0-B** (backfill histórico): pendiente de tu decisión sobre los 6 casos ambiguos cerrados (210.390 ARS) y la orden cancelada con repuesto consumido (16.000 ARS).
3. **Reinterpretar `service_with_cogs`** + integrar el detector al panel de Health Check.
4. Los dos **P1** registrados.

---

**Artefactos:** PR [#29](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/29) · merge `4675ab6` · migración `20260730120000` · deploy Vercel Production `ref=4675ab6539`.
**Informes:** [diagnóstico](informe-diagnostico.md) · [implementación](informe-p0a-implementacion.md) · este informe.
