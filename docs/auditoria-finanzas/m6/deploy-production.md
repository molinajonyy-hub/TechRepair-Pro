# M6 — Deploy a producción (registro)

> Nota **local** (no se commitea durante el deploy salvo autorización posterior).

## Contexto

- Fecha: 2026-07-08 (hora local del deploy).
- HEAD local: `0711906` (fix(finance): route remaining ledger operations through atomic RPCs)
- origin/main pre-deploy: `1b23bc2`
- Proyecto prod Supabase: `vrdxxmjzxhfgqlnxmbwx` (techrepair-pro, us-east-1, ACTIVE_HEALTHY, pg 17.6)

## Baseline read-only PRE-deploy (producción)

| Métrica | Valor |
|---|--:|
| Migraciones aplicadas (total) | 153 |
| Última migración aplicada | `20260705110000` (Etapa 1) |
| Migraciones M6 aplicadas | **0** ✓ |
| Negocios | 19 |
| Cajas abiertas | 4 |
| **Cajas abiertas duplicadas por negocio** | **0** ✓ |
| Comprobantes | 208 |
| comprobante_payments | 206 |
| financial_movements | 232 |
| business_finance_entries | 312 |
| order_payments | 1 |
| supplier_payments | 3 |
| expenses | 18 |

### Estado pre-migración (M6 aún no existe)
- 8 RPCs M6: **ausentes** ✓
- Columnas `reversed_at` (FM/BFE/expenses/order_payments): **ausentes** ✓
- Columnas nuevas de `order_payments`: **ausentes** ✓
- 8 tablas request/reversal M6: **ausentes** ✓
- Policies `ALL` en tablas críticas: **3** (esperado; las dropea M6):
  - `cajas.cajas_staff` → migración `20260706180000`
  - `supplier_payments.rls_supplier_payments` → migración `20260706160000`
  - `supplier_account_movements.rls_supplier_account_movements` → migración `20260706160000`
  - Post-M6 debe quedar **0** (invariante F9-24).

## Riesgos y rollback lógico

- **Ventana de incoherencia:** al pushear, Vercel deploya el frontend M6 (que llama RPCs nuevas)
  antes/durante la aplicación de migraciones. Mitigación: aplicar `db push` **inmediatamente**
  tras el push. Los flujos financieros pueden fallar hasta que las 7 migraciones estén aplicadas.
- **Migraciones aditivas:** columnas nullable + tablas/RPCs nuevas + DROP/CREATE de policies.
  No reescriben históricos ni montos. `db push` rápido.
- **Rollback lógico (no borrar datos):** si algo sale mal, revertir el frontend a `1b23bc2`
  en Vercel (redeploy del commit previo). Las RPCs/policies nuevas son inertes si el frontend
  viejo no las llama; las policies endurecidas podrían bloquear escrituras directas del frontend
  viejo (que ya no existían salvo E1/E2/E3). NO hacer `db reset` ni borrar migraciones en prod.
- Correcciones económicas: **append-only**. Sin backfill. Sin tocar históricos.

## Resultado del deploy (2026-07-08)

- [x] `git push` OK — `1b23bc2..0711906 main -> main`; origin/main = HEAD = `0711906`, ahead 0/behind 0.
- [x] `db push` — **7 migraciones M6 aplicadas** (dry-run confirmó exactamente esas 7, ninguna inesperada).
- [x] **Verificación DB post-migración (todo ✓):**
  - 7 migraciones M6 en `schema_migrations`.
  - 8 RPCs presentes, todas SECURITY DEFINER + `search_path=public`; `replace_comprobante_payment` = 12 args.
  - 8 tablas request/reversal presentes. `reversed_at` en FM/BFE/expenses/order_payments. 6 columnas nuevas en `order_payments`.
  - **0 policies `ALL`** en tablas críticas (las 3 previas dropeadas: `cajas_staff`, `rls_supplier_payments`, `rls_supplier_account_movements`).
  - Conteos idénticos al baseline (sin pérdida ni mutación de históricos). 0 cajas abiertas duplicadas.
- [x] **Vercel Production OK** — `version.json.commit = 0711906` (buildTime 2026-07-08T13:17:59Z) en `techrepairpro.app`, `www.techrepairpro.app`, `clicmayorista.com.ar`.
- [x] **Monitoreo read-only inmediato (todo ✓):** 0 huérfanos FM/BFE, 0 payment_fee sin comprobante, 0 reversals sin original, 0 expenses reversadas sin auditoría, request tables vacías (sin ops aún), dashboard responde.
  - ⚠️ 1 `supplier_payment` sin ledger vinculado — **PRE-EXISTENTE** (registro previo a M6; no regresión; sin backfill).
- [ ] **Smoke manual humano — PENDIENTE (a cargo del usuario):** requiere sesión real; ver checklist en el reporte de Fase K.
- [ ] **Tag** — NO creado (gated en el smoke humano).
- [ ] Monitoreo 24 h (correr las consultas de integridad tras la actividad real).
