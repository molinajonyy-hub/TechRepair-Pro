# ORDERS-V2-0.1 · Audit de importes

Inventario pedido en los bloques G, K y L. Baseline `3b8406c`.

---

## 1 · Helpers de formato que ya existían

**No se creó un helper nuevo con criterio propio.** `lib/money.ts` promueve a un
lugar neutral el criterio que `financeInsightPresentation` ya aplicaba bien.

| Helper | Ubicación | Criterio | Estado |
|---|---|---|---|
| `formatPrice(v, currency)` | `utils/priceCalculator.ts:125` | **`$` para ARS y para USD** — sólo cambian los separadores | ⚠️ **es el bug reportado** |
| `formatARS` / `formatUSD` | `lib/finance/financeInsightPresentation.ts:25,32` | `Intl` + `style:'currency'` → `$ 85.000,00` / `US$ 85.000,00` | ✅ correcto; es el criterio que se promovió |
| `formatAxisARS` | `lib/finance/chartsL1Presentation.ts:186` | ejes de gráficos, abreviado | ✅ propósito específico, se conserva |
| `formatSubscriptionPrice` | `services/subscriptionService.ts:367` | precios del SaaS | ✅ dominio propio |
| `formatImporteWhatsApp` | `services/whatsappTemplate.ts:116` | plantillas de mensajes | ✅ dominio propio |
| `formatCostOrRestricted` | `services/inventoryCostAccess.ts:208` | SEC-08B: costo o «restringido» | 🚫 no tocar |
| ~64 archivos | inline `Intl.NumberFormat` | disperso | 📋 follow-up |

### La causa exacta del reporte del owner

```ts
// utils/priceCalculator.ts:125
export function formatPrice(price: number, currency: Currency = 'ARS'): string {
  if (currency === 'USD') return `$${price.toLocaleString('en-US', …)}`   // $85,000.00
  return `$${price.toLocaleString('es-AR', …)}`                          // $85.000,00
}
```

Las dos ramas emiten `$`. En Argentina `$` ya significa pesos, así que usarlo
también para dólares no es ambiguo: es engañoso. Viola la regla explícita del
pedido: «No usar "$" solo para USD».

`formatPrice` **no se modificó en este lote**: lo consumen superficies de
precio de inventario, POS y portal mayorista, y cambiar su salida altera lo que
se ve en todas ellas a la vez. Corregirlo merece su propio lote con evidencia
visual por superficie. Queda como el primer ítem del follow-up.

---

## 2 · Autoridad nueva

| Pieza | Rol |
|---|---|
| `lib/money.ts` · `formatMoney(v, currency)` | **DISPLAY**. `$ 85.000,00` / `US$ 85.000,00` |
| `lib/money.ts` · `formatMoneyInput(raw)` | **INPUT**. Agrupa mientras se escribe; conserva `1000,` y `1000,0` |
| `ui/AppMoneyInput` | Moneda + monto como una sola unidad visual |
| `features/order-intake/model.ts` · `parseLocalizedAmount` | **PARSING — sin cambios.** Sigue siendo la única autoridad de string → número |

Separación que el pedido exige mantener: *input formatting* (lo que se ve
mientras se tipea) es distinto de *display formatting* (lo que se lee después),
y ninguno de los dos es *parsing*.

---

## 3 · Clasificación de las superficies con input de importe

114 inputs numéricos en 41 archivos.

### ✅ SAFE TO MIGRATE NOW — migrado en este lote

| Superficie | Por qué es seguro |
|---|---|
| `pages/NewOrder.tsx` · presupuesto | `orders.estimated_total` es un estimado: la propia pantalla dice «no registra pagos ni movimientos financieros». No entra al ledger ni a caja. |

### 🚫 SEC-08 SENSITIVE — no tocar

| Superficie | Motivo |
|---|---|
| `components/order/OrderCostManagement.tsx` | Costos de orden · SEC-08E |
| `components/order/PartsUsedCard.tsx` | Importes de repuestos · SEC-08E |
| `components/order/PaymentCard.tsx` | Pagos de orden |
| `components/comprobantes/*` (5 archivos) | Emisión, ítems y totales de comprobante |
| `components/cobro/ModalCobro.tsx` | Cobro — escribe caja y ledger |
| `components/finance/AllocationModal.tsx`, `AllocationHistory.tsx` | Imputaciones · payment allocations |
| `pages/CuentasCorrientes.tsx` | Cuenta corriente de clientes |
| `pages/CajaPage.tsx` | Movimientos de caja |
| `pages/Inventory.tsx` (14) | Costos · SEC-08B `formatCostOrRestricted` |
| `pages/Suppliers.tsx`, `Purchases.tsx` | CC proveedor · SEC-08C |

### 📋 FOLLOW-UP — presentación, pero fuera del alcance de un lote de human-smoke

| Superficie | Nota |
|---|---|
| `utils/priceCalculator.formatPrice` | **Prioridad 1.** Es el bug de raíz; afecta POS, inventario y portal a la vez |
| `pages/Expenses.tsx` (6) | Gastos: escribe finanzas, revisar con criterio financiero |
| `pages/Offers.tsx`, `Mayorista.tsx`, `mayorista/*` | Precios de catálogo mayorista |
| `components/products/ProductFormModal.tsx` (4) | Precios de producto |
| `personal/**` (7 archivos) | Mi Guita: dominio y moneda propios |
| `pages/Settings.tsx`, `PaymentMethodSettings.tsx` | Son **porcentajes**, no importes — no corresponde este input |
| `pages/CurrencySettings.tsx` | Cotización, no importe |
| `pages/AdminSubscriptions.tsx`, `AdminPortalClic.tsx` | Admin del SaaS |
| `components/warranties/WarrantyFormModal.tsx` | Revisar si el campo es monetario |

**Conclusión honesta:** fuera de NewOrder, ninguna otra superficie califica como
«claramente presentation-only y de riesgo bajo». Todas escriben un importe con
semántica financiera o están bajo SEC-08. Migrarlas ahora sería exactamente el
sweep gigante que el pedido descarta.

---

## 4 · Regla para adelante

> No crear inputs de dinero nuevos con `AppInput semantic="decimal"`.
> Se usa `AppMoneyInput`, y para mostrar importes `formatMoney`.

Queda anotada en el export de `src/ui/index.ts` y en el encabezado del propio
componente, que es donde la va a leer quien esté por escribir el próximo.
