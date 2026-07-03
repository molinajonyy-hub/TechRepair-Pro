# Etapa 0 — Fase 8: Datos históricos (reporte, SIN backfill)

Regla de esta etapa: **no se altera producción, no se fabrican sesiones de caja
antiguas, no se inventan pagos**. Este documento reporta, clasifica y propone;
la ejecución queda para una migración futura revisada a mano.

## 1. Los 24 FM con `caja_id IS NULL` (negocio Clic, medición 2026-07-02)

Clasificación por `source` (query R-1 abajo):

| source | filas | monto ARS | Interpretación | Estrategia propuesta |
|---|---|---|---|---|
| `comprobante` | 15 | $646.238 | cobros registrados sin caja abierta (el trigger no encontró sesión) | NO asignar a cajas pasadas. Crear en M7 una **sesión virtual "Sin caja" por mes histórico** (etiqueta, no caja real) o simplemente marcarlos `legacy_no_session=true` y excluirlos de arqueos, manteniéndolos en P&L/flujo. Preferida: columna flag + filtro en UI de arqueo. |
| `bfe` | 7 | $2.626.400 | gastos/asientos espejo de flujos viejos | ídem flag; revisar 1×1 si duplican `expenses` (script R-2) |
| `cobro_rapido` | 1 | $20.190 | cobro rápido sin caja | ídem flag |
| `pago_proveedor` | 1 | $304.930 | pago a proveedor sin caja | ídem flag |

Con el índice único de caja abierta + la regla de la nueva RPC de anulación
(exige caja abierta para devoluciones), **no se generan nuevos huérfanos de
sesión** salvo por los caminos legacy que siguen insertando FM sin caja cuando
no hay sesión (trigger `trigger_set_movement_caja` deja NULL). Cerrar ese grifo
por completo (rechazar movimientos de caja sin sesión) es decisión de M6 —
requiere definir el flujo "cobrar sin caja abierta" con el dueño.

```sql
-- R-1: clasificación por source y mes (read-only)
SELECT source, date_trunc('month', COALESCE(date::timestamp, created_at)) AS mes,
       count(*) AS filas, ROUND(SUM(amount_ars)) AS monto
FROM financial_movements
WHERE business_id = 'aa930802-0861-46ce-896c-7f68b181cb39' AND caja_id IS NULL
GROUP BY 1, 2 ORDER BY 2, 1;
```

## 2. Comprobantes pre-RPC desincronizados (2 casos)

| Comprobante | Estado | Problema | Acción propuesta (manual, revisable) |
|---|---|---|---|
| `de5b7c70…` (`0001-00000001`, 2026-04-23) | emitido / `pagado`, `total_cobrado=7500` | tiene BFE income $7.500 pero **cero** `comprobante_payments` y cero FM | Insertar (script manual firmado) el pago faltante de $7.500 con fecha original y `notes='backfill auditoría 2026-07'` **solo si el dueño confirma que se cobró**; si no, anularlo con la nueva RPC. NO se hace automáticamente. |
| `cb590249…` (borrador, 2026-04-21) | borrador / `pendiente`, `total_cobrado=332000` | `total_cobrado` escrito sin pagos, sin FM, sin BFE | El dato es solo la columna materializada: corregir `total_cobrado=0, saldo_pendiente=total` con UPDATE puntual documentado, o eliminar el borrador si el dueño confirma que fue prueba. Bloqueado hoy por el delete-guard si tuviera efectos (no los tiene: candidato a D1). |

```sql
-- R-3: re-detección (misma query C7 de supabase/tests/finance_conciliaciones.sql)
SELECT c.id, COALESCE(c.numero_fiscal, c.numero) AS numero, c.estado_comercial,
       c.total_cobrado,
       (SELECT COALESCE(SUM(amount_ars), 0) FROM comprobante_payments cp WHERE cp.comprobante_id = c.id) AS suma_pagos
FROM comprobantes c
WHERE c.business_id = 'aa930802-0861-46ce-896c-7f68b181cb39'
  AND abs(COALESCE(c.total_cobrado, 0) -
      (SELECT COALESCE(SUM(amount_ars), 0) FROM comprobante_payments cp WHERE cp.comprobante_id = c.id)) > 1;
```

## 3. Otros pasivos históricos detectados durante la etapa (para M3/M6/M7)

- **BFE de costo pre-20260702110000**: `source='manual'` sin `reference_comprobante_id`
  → siguen siendo editables bajo la policy nueva (documentado en la migración de
  ledger). M7 puede backfillear `source='comprobante'` + referencia matcheando la
  descripción determinista `'Costo de productos - Comprobante #<numero>'`.
- **8 pagos con `date` UTC corrida** (query C11 de conciliaciones): reporte solo;
  corregir la columna `date` al día AR derivado de `created_at` es un UPDATE
  masivo que M7 debe hacer con snapshot previo.
- **`registrarPagoCC` roto** (inserta columna inexistente `caja_id` en BFE con el
  error silenciado): los cobros de CC históricos NO tienen BFE. Se repara el flujo
  en M6 (RPC de cobro CC con FM); el backfill de BFE faltantes se decide ahí.
