# P0-CC · CC-0 — Medición read-only de producción

**Fecha:** 2026-08-25
**Proyecto:** `vrdxxmjzxhfgqlnxmbwx` (techrepair-pro)
**Migration head prod:** `20260828120000` — 237 migraciones (idéntico a repo y local)
**Naturaleza:** exclusivamente `SELECT`. Cero `INSERT`/`UPDATE`/`DELETE`. Cero reparación.

---

## Veredicto CC-0: **A — 0 movimientos huérfanos de método de pago**

No existe en producción **ningún** `financial_movements.metodo_pago` fuera del catálogo de
Caja. En particular **no existe ni un solo `debito` ni `credito`**.

CC-2 (el bug que evapora plata del arqueo) es **real en el código pero nunca se disparó en
producción**: `ModalPagarCC` sólo es alcanzable desde la ficha del cliente, y nadie eligió
esos métodos allí.

### Distribución completa de `metodo_pago`

| `metodo_pago` | ¿En catálogo? | Movimientos | Suma ARS | Cajas | Sin caja | Rango | Negocios |
|---|---|---:|---:|---:|---:|---|---:|
| `transferencia` | ✅ | 213 | 12.238.536,24 | 67 | 12 | 2026-04-29 → 2026-08-25 | 4 |
| `efectivo` | ✅ | 140 | 5.956.604,00 | 56 | 25 | 2026-04-28 → 2026-08-24 | 4 |
| `tarjeta` | ✅ | 19 | 1.997.553,00 | 11 | 1 | 2026-04-29 → 2026-08-08 | 1 |
| `NULL` | ✅ (vía `COALESCE`) | 8 | 2.639.450,00 | 1 | 7 | 2026-04-20 → 2026-05-21 | 1 |
| **fuera de catálogo** | — | **0** | **0** | — | — | — | — |

**Nota sobre los 8 `NULL`:** `close_cash_session_atomic` los trata como `efectivo`
(`COALESCE(metodo_pago,'efectivo')`). Siete no están atados a ninguna caja; uno sí. Son de
abril/mayo, anteriores al contrato actual. **No se reparan** — quedan registrados.

---

## Cobros legacy de Cuenta Corriente: **1 caso, identificado con precisión**

Criterio determinístico usado: un cobro canónico produce un `financial_movements` con
`reference_type='account_movement'` y `reference_id = account_movements.id`. Un `credit` en
`account_movements` sin ese enlace es un cobro que **no llegó a la caja**.

**Resultado: exactamente 1 movimiento en toda la base.**

| Campo | Valor |
|---|---|
| `account_movement_id` | `bdd1e30e-1ccf-4c11-b12f-c52600af4ca4` |
| `business_id` | `e458c591-ce41-4a72-8f5f-249bb760bad5` |
| `account_id` | `cf47e1f8-204a-4e38-a47b-4b1d5b2c4db5` |
| Fecha económica | 2026-08-25 |
| Creado | 2026-08-25 00:35:48 UTC |
| Monto | **ARS 500.000** |
| `description` | **`"efectivo"`** |
| `balance_after` | 320.000 (venía de 820.000) |
| `financial_movement` | **NO EXISTE** |
| BFE `cobro_cuenta_corriente` | **NO EXISTE** |
| Filas de auditoría | 1 (`trigger_backstop` — el backstop sí dejó rastro) |
| Caja del día | `bcfdc473-4fd2-4a53-bb78-20a84f0c14bb` — **ABIERTA** |

### Dos lecturas importantes

1. **Es la prueba humana que originó esta auditoría.** Fecha y hora coinciden con el reporte
   del owner.

2. **El owner escribió `"efectivo"` en el campo descripción.** Es la evidencia más directa
   del defecto de UX: al no haber selector de método, usó el único campo libre disponible
   para registrar cómo le pagaron. La descripción estaba **sustituyendo** a `payment_method`,
   exactamente como describió el informe de discovery.

### La caja afectada sigue ABIERTA

Esto es material para CC-G: **no se viola la regla de «no recalcular cajas cerradas»** si la
reparación se hace antes de que esa sesión se cierre. Una vez cerrada, la diferencia queda
consolidada en el snapshot y reparar exige un flujo contable distinto.

> **Acción recomendada al owner, fuera de este lote:** decidir si esos ARS 500.000 entraron
> físicamente al cajón. Si entraron, la caja `bcfdc473…` tiene hoy 500.000 más de efectivo
> del que el arqueo espera, y va a cerrar con esa diferencia.

---

## Integridad del saldo: **0 divergencias**

| Métrica | Valor |
|---|---:|
| Cuentas totales | 2 |
| De tipo `cliente` | 2 |
| Con movimientos | 2 |
| **Divergentes (`balance` ≠ `SUM(debit-credit)`)** | **0** |
| Suma de divergencia | 0 |
| Negocios con cuenta corriente | 2 |
| Deuda viva total | ARS 320.001 |

**CC-3 nunca fue explotado.** El agujero de escritura directa sobre `accounts.balance` es
real y hay que cerrarlo, pero nadie lo usó: las dos verdades del saldo coinciden exactamente.
El lockdown de CC-C se aplica sobre datos limpios.

---

## Consecuencias para el plan

| Hallazgo | Efecto sobre los lotes |
|---|---|
| 0 métodos huérfanos | **CC-G queda vacío en la dimensión «métodos»**. El normalizador de CC-A es puramente preventivo. Sin reparación histórica pendiente. |
| 1 cobro legacy, caja abierta | Único ítem real de CC-G. Acotado, identificado y con ventana de reparación abierta. |
| 0 divergencias de saldo | El lockdown de CC-C no necesita saneamiento previo. |
| 2 cuentas, 2 negocios | Blast radius mínimo. El riesgo de los lotes restrictivos (CC-C, CC-E) es mucho menor de lo estimado en el discovery. |

---

## Handoff: **CC-G — reparación histórica** (NO se ejecuta en este lote)

Alcance total, cerrado y determinístico:

- **1** `account_movements` sin `financial_movement` ni BFE: `bdd1e30e-1ccf-4c11-b12f-c52600af4ca4`, ARS 500.000.
- **0** movimientos con método fuera de catálogo.
- **8** `financial_movements` con `metodo_pago NULL` de abril/mayo (comportamiento actual: se
  cuentan como efectivo; 7 sin caja). Decidir si se normalizan explícitamente o se dejan.

**No se reconstruye nada por inferencia.** El caso está identificado por su `id`; no hace
falta adivinar. Requiere decisión de negocio (¿la plata entró al cajón?) antes que decisión
técnica.

---

## Consultas ejecutadas

Cuatro `SELECT`, todas sin efectos:

1. `supabase_migrations.schema_migrations` — head y conteo.
2. `financial_movements` agrupado por `metodo_pago` con marca de pertenencia al catálogo.
3. `account_movements` con `credit > 0` y `NOT EXISTS` del `financial_movements` enlazado.
4. `accounts` vs `SUM(debit-credit)` derivado, para detectar divergencia.

**Filas de negocio modificadas: 0.**
