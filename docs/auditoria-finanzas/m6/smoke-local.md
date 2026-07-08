# M6 · Fase 12 — Smoke local UI

## Alcance y método (importante)

Se levantó la app local (Vite `:5173`) apuntada **a la Supabase local** vía un `.env.local`
temporal (`VITE_SUPABASE_URL=http://127.0.0.1:54621`, gitignored, **removido al terminar**).

> ⚠️ **Hallazgo de seguridad:** el `.env` versionado apunta a una instancia **remota/producción**
> (`https://vrdxxmjzxhfgqlnxmbwx.supabase.co`). Correr `npm run dev` sin override haría que la
> UI escriba en **producción**. Por eso el smoke se hizo **solo contra local** (confirmado por
> red: ninguna request pegó al host de producción). Ver riesgo residual R1.

**Autenticación:** los flujos migrados viven detrás del login. Por regla de seguridad **no ingreso
contraseñas en formularios ni creo cuentas para autenticarme**, por lo que **no se condujo el
click-through interactivo autenticado**. En su lugar el smoke se apoyó en tres señales
verificables y de alta confianza, más la prueba SQL exhaustiva ya existente (cada RPC probada
end-to-end en Fase 3-11):

1. **Smoke de carga** — app renderiza el login, **0 errores de consola**, red 100% local.
2. **Integridad de módulo** — los 12 archivos migrados se importan dinámicamente vía Vite sin
   error (detecta imports/exports rotos tras las ediciones, incl. remociones de código muerto).
3. **Verificación estática handler→RPC** — cada handler de UI invoca la RPC correcta con los
   parámetros correctos y maneja errores + `IDEMPOTENCY_CONFLICT`.

## Resultados por flujo

| Flujo | Resultado | Evidencia | Bug | Fix | Riesgo residual |
|---|---|---|---|---|---|
| **1. Caja** — abrir / mov. manual / cerrar / cerrada inmutable | OK (estático + carga) | `CajaPage.tsx:401` `open_cash_session_atomic`; `:441` `create_manual_cash_movement_atomic`; `:475` `close_cash_session_atomic`; `:514` `reverse_manual_cash_movement`. Sin insert/update directo (guard 0 viol). Cierre server-side (toast usa `data.difference`). Módulo importa OK. Suites Fase 4 (21) + F9-15/17/18. | — | — | R2 (no driven en vivo) |
| **2. Cuenta corriente** — cobro parcial/total, efectivo/transferencia, conflict | OK (estático) | `ModalPagarCC` → `cuentasService.registrarPagoCC` → `record_customer_account_payment_atomic` (`cuentasService.ts:262`), params OK, lanza `Error.code='IDEMPOTENCY_CONFLICT'`. Suites Fase 3 (17) + integridad B2. | — | — | R2 |
| **3. Gastos** — crear / reversar con motivo / factura bloqueada | OK (estático + carga) | `Expenses.tsx:1113` `reverse_operating_expense_atomic`; factura → `alert` y `return` (`:1107`); motivo obligatorio (`window.prompt`, `:1110`); `IDEMPOTENCY_CONFLICT` manejado; `loadExpenses()` refresca. Suites Fase 5 (22) + integridad B6/B7/C6. | — | — | R2, R3 (window.prompt UX) |
| **4. Órdenes** — pago ARS/transferencia/USD + reverso | OK (estático) | `PaymentCard.tsx:83`/`OrderCostManagement.tsx:206`/`ModalCobro.tsx:397` `create_order_payment_atomic`; `PaymentCard.tsx:118`/`OrderCostManagement.tsx:278` `reverse_order_payment_atomic`. USD manda `exchange_rate`; `amount_ars` server-side. Suites Fase 6 (26) + integridad B3/B4/B5/C4. | — | — | R2 |
| **5. Proveedores** — compra, pago, pago libre, borrar con pagos | OK (estático) | `suppliersService.ts:255` `create_supplier_purchase_atomic`; `:361` `pay_supplier_purchase_atomic`; `:341` `pay_supplier_free_atomic`; `:303` `delete_supplier_purchase_safe` (bloquea `blocked_paid`). Suites Fase 7 (9) + integridad B8/B9/C5. | — | — | R2 |
| **6. Comprobante replace** — efectivo→transferencia, tarjeta+comisión→efectivo, nueva comisión | OK (estático) | `comprobanteService.ts:959` `replace_comprobante_payment` (12 args con `commission_amount`/`payment_provider`/`idempotencyKey`); `Comprobante.tsx` pasa key por submit. Suites Fase 8 (24) + integridad B10/B10b. | — | — | R2, R4 (comprobante ligado a orden: caso borde no driven) |
| **7. Guard / excepciones vivas** | OK | `npm run guard:finance-writes`: 3 detectadas, 3 permitidas (E1/E2/E3), **0 violaciones**; self-test 13/13. | — | — | — |
| **8. Consola / red durante carga** | OK | 0 errores de consola; 0 requests a producción; 12 módulos migrados importan sin error. | — | — | — |

**Leyenda:** *OK (estático)* = handler→RPC verificado en código + probado por SQL end-to-end;
*OK (carga)* = además el módulo se cargó/importó vivo sin error; *no driven en vivo* = el
click-through autenticado no se ejecutó por la restricción de credenciales.

## Bugs encontrados / fixes

**Ninguno.** No se detectó handler roto, RPC inexistente, error de firma, ni intento de escritura
directa. No se aplicó ningún fix de código en Fase 12.

## Riesgos residuales

- **R1 · `.env` apunta a producción.** Riesgo operativo: cualquiera que corra `npm run dev` sin
  override escribe en prod. **Recomendación:** documentar/usar `.env.local` para dev local (ya
  gitignored) o cambiar el default. *(Fuera del scope de código M6 — no se modificó `.env`.)*
- **R2 · Click-through autenticado no ejecutado en vivo** (restricción de credenciales). Mitigado
  por: prueba SQL end-to-end de cada RPC (Fase 3-11), integridad de módulo, y verificación
  estática handler→RPC. **Recomendación:** smoke manual humano pre-deploy siguiendo esta misma
  grilla de flujos.
- **R3 · `window.prompt` para el motivo de reverso** — UX mejorable, no bloqueante.
- **R4 · Replace de comprobante ligado a una orden** — caso borde no cubierto por tests unitarios
  ni driven en vivo (el común, sin orden, sí). Validar en el smoke manual si se usa.

## Cómo reproducir el smoke local (seguro)

```bash
# 1. Apuntar la app a la Supabase LOCAL (no committear; .env.local está gitignored)
#    VITE_SUPABASE_URL=http://127.0.0.1:54621 ; VITE_SUPABASE_ANON_KEY=<anon local de `npx supabase status`>
# 2. Levantar
npm run dev
# 3. Loguearse con un usuario de prueba local y recorrer los flujos 1-6 de la grilla.
# 4. Confirmar en la pestaña de red que cada acción llama /rest/v1/rpc/<rpc-esperada> y NADA pega a prod.
# 5. Borrar .env.local al terminar.
```
