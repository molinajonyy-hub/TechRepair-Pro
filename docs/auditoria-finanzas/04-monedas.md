# Fase 5 — Auditoría de monedas (ARS / USD / tipo de cambio)

## 1. Cómo fluye el dólar hoy

```
InfoDolar Córdoba (scraping HTML, "venta" blue)      Bluelytics (blue nacional)
        └── Edge Function infodolar-cordoba ──────────────┘
                     └── exchange_rates (business_id, USD→ARS, rate, updated_at)
                            ├── set_exchange_rate_on_product_save (trigger):
                            │     productos USD sin TC → congela exchange_rate_used
                            │     y deriva sale_price = base_price × TC
                            ├── POS: exchange_rate global del comprobante + por ítem (snapshot)
                            └── CajaPage/Finance: cotización "actual" para mostrar equivalentes
```

Estado real (Clic, 2026-07-02): TC actual **1541** · 475 productos USD, todos con `exchange_rate_used = 1490` · capital USD a costo $18.419.246 ARS · 0 ítems vendidos en moneda USD (todo se convierte antes de facturar) · 0 inconsistencias `amount_ars ≠ amount × rate` en FM.

## 2. Veredictos por área

| Área | Estado | Detalle |
|---|---|---|
| **Ventas históricas** | ✅ correcto | `comprobante_items` guarda `currency`, `exchange_rate`, `costo_unitario`, `precio_unitario` como snapshot. Cambiar el dólar hoy NO recalcula rentabilidad pasada. Es la regla más importante y se cumple. |
| **Pagos** | ✅ | CP guarda amount + amount_ars + exchange_rate por fila. |
| **Precios de lista USD** | ⚠️ | `sale_price` se deriva del TC **al guardar el producto**. Si el dólar sube y nadie re-guarda, se vende a TC viejo: hoy toda la lista USD está 3,3% abajo (1490 vs 1541). No hay job ni botón "actualizar precios al TC de hoy", ni indicador de antigüedad del TC en la ficha/POS. |
| **Inventario valorizado** | ⚠️ | Capital inmovilizado usa `cost_price` (ARS congelado al TC de la última compra/alta). Vale como "costo histórico", pero el panel lo presenta sin aclarar que NO es valor de reposición. Diferencia silenciosa actual ≈ $630k sobre $18,4M. |
| **Caja USD** | ⚠️ | Métodos por sesión ok (`usd` cuenta en USD nativo ✅). Pero la **diferencia de cierre** USD se convierte al TC del momento del cierre (no al de apertura ni al promedio), y `cajas.difference` mezcla ARS+USD convertido en un solo número. |
| **Órdenes en USD** | ❌ | `trigger_payment_creates_movements` inserta `amount_ars = amount` con TC=1 → un pago de orden de u$s100 entra a caja y P&L como $100 ARS (P1-8). |
| **Reportes** | ⚠️ | Todos los agregados son en ARS nominal sin ajuste; correcto como decisión, pero no está documentado ("los totales históricos son pesos de cada fecha"). Comparaciones mes vs mes en contexto inflacionario + TC móvil pueden malinterpretarse. |
| **Ganancia por diferencia de cambio** | Ø | No existe. Si se cobra en USD y se gasta en ARS, la ganancia/quebranto cambiario queda implícito dentro del margen. Aceptable para el segmento, pero decidirlo explícitamente. |

## 3. Política documentada (propuesta para adoptar tal cual)

Cuándo usar cada valor — hoy esto está implícito y disperso; debe quedar escrito y visible en la UI ("ⓘ ver fórmula"):

| Contexto | Valor a usar | Justificación |
|---|---|---|
| Venta / rentabilidad histórica | **TC de la operación** (snapshot del ítem/pago) | inmutable; ya implementado |
| Precio de lista de producto USD | **TC actual** en el momento de vender (no el congelado de la ficha) | evita vender a dólar viejo; requiere cambio: derivar precio en POS desde `base_price × TC_actual` con fallback al congelado |
| Capital inmovilizado (reporte) | dos columnas: **costo histórico** (hoy) y **reposición a TC actual** (`base_price_usd × TC_hoy`) | la brecha entre ambas ES información (exposición cambiaria) |
| Deudas CC (clientes/proveedores) | **ARS nominal** salvo deuda pactada en USD (hoy no modelada) | no reexpresar deudas sin acuerdo explícito |
| Arqueo de caja USD | contar en **USD nativo**; equivalente ARS informativo al TC de apertura de sesión | la diferencia de arqueo debe ser en la moneda contada |
| Reportes agregados | ARS nominal por fecha + leyenda fija "valores nominales de cada fecha" | evita falsa precisión |

## 4. Riesgos concretos a corregir

1. **P1-8** — pagos de orden USD 1:1 (trigger): convertir con TC vigente y guardar el TC usado.
2. **Refresh de lista USD**: acción masiva "re-valuar productos USD al TC de hoy" (ya existe `set_exchange_rate_on_product_save`; falta un update disparable) + badge "TC ficha: 1490 · hoy: 1541" en POS/inventario.
3. **Redondeos**: los display usan `Math.round` (CajaPage) y `maximumFractionDigits: 0`; la DB guarda numeric sin redondear — correcto, pero definir regla única de redondeo a peso entero en presentación y **nunca** en persistencia.
4. **`calcularLinea`**: `subtotalUSD += baseTotal / globalRate` cuando la línea es ARS — si `globalRate=1` (default), `total_usd` del comprobante queda igual al total ARS: campo `total_usd` no confiable para reportes (documentar o poblar solo cuando hay TC real).
5. **Fallback TC=1**: `set_exchange_rate_on_product_save` usa 1.0 si no hay cotización → un producto USD dado de alta antes del primer fetch queda con sale_price = base_price (regalado). Debería rechazar o marcar "sin TC".
