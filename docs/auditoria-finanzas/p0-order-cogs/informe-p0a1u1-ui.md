# P0-A.1U1 — Estados financieros visibles en órdenes · informe local

**Fecha:** 2026-07-30 · Rama `fix/p0a1-order-completion-payment-status` · commit nuevo **`a0004b7`**
Los cinco commits previos (`def017a`, `045efe6`, `e8948db`, `c2edfad`, `dc95d7e`) quedaron intactos.
**No publicado, sin PR, sin deploy, sin migraciones, sin backfills, sin tocar el Health Check.**

---

## 1. Entorno de tests elegido

**Vitest + jsdom + @testing-library/react + user-event**, en configuración **separada** (`vitest.config.ts`), que sólo mira `tests/components/**/*.test.tsx`. Los **572 tests de `node --test` no se migraron ni se tocaron**: siguen con su script y su runner.

El setup (`tests/components/setup.ts`) es fail-closed:
- `fetch` **lanza** si un test intenta salir a la red, así que un componente que se conecte de verdad a Supabase no puede pasar inadvertido;
- variables de entorno **falsas** y explícitas (`http://localhost:0/test-only`);
- `matchMedia` stubeado (jsdom no lo trae y el tema lo consulta);
- `cleanup` automático y `restoreMocks`.

Los mocks van en el **límite** (`src/lib/supabase`, `useAuth`), nunca del componente bajo prueba.

## 2. Dependencias agregadas

`vitest@^2`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` — todas en `devDependencies`.

**Nota de instalación:** el repo fija `@rollup/rollup-linux-x64-gnu` en `dependencies` (necesario para el build de Vercel, que corre en Linux). En Windows eso hace fallar `npm install` con `EBADPLATFORM`, así que la instalación se hizo con `--force`. **No toqué esa dependencia**: cambiarla afectaría el deploy. El `build` posterior pasa OK.

## 3. Scripts

`test:components` (una corrida) y `test:components:watch`. `test:unit`, `lint`, `build` y `guards` quedan **sin cambios semánticos**.

## 4. Componentes y archivos

| Archivo | Rol |
|---|---|
| `src/components/orders/OrderFinancialBadge.tsx` | **nuevo** — badge de estado financiero |
| `src/components/orders/OrderFinancialSummary.tsx` | **nuevo** — resumen de solo lectura del detalle |
| `src/hooks/useOrders.ts` | filtros server-side + estado financiero por lote |
| `src/pages/Orders.tsx` | columna «Cobro», badge, saldo y filtro de cobro |
| `src/pages/OrderDetail.tsx` | monta el resumen financiero |
| `vitest.config.ts`, `tests/components/setup.ts` | **nuevos** — entorno |
| `tests/components/*.test.tsx` | **nuevos** — 14 tests |
| `scripts/finance/guard-order-payment-status.mjs` | +4 reglas, 15 fixtures |

**Sin cambios en `supabase/`** — verificado: `git status --short supabase/` devuelve 0 archivos. No hay migración en este lote.

## 5. Fuentes server-side usadas

`v_order_financial_status` (estado, totales, saldo, `imputado_cc`, comprobante, `completed_at`, `paid_at`, `ultimo_pago`) y `v_customer_unallocated_credit` (crédito sin imputar). **Ninguna de las tres fuentes prohibidas** (`orders.amount_paid`, `comprobantes.payment_status`, `orders.comprobante_id`) se usa en el código nuevo.

## 6. Prevención de N+1

**Dos consultas por página, sin importar cuántas órdenes haya:**

1. las órdenes (con su filtro técnico y, si hay filtro financiero, acotadas por `.in('id', ids)`);
2. **una sola** consulta a `v_order_financial_status` con `.in('order_id', [...])` para todo el lote.

Cuando hay filtro financiero, la vista canónica filtra y limita **antes**: nunca se descargan todas las órdenes para filtrarlas después.

## 7. Badges

Cuatro estados con **texto siempre visible** (el color nunca es el único portador de significado), `title` con la ayuda pedida, `aria-label` completo y colores desde **tokens de tema** (`var(--…)`), lo que garantiza light y dark sin hardcodear. Un test verifica que el `style` no contenga ningún hex fijo.

## 8. Filtros

Nuevo selector «Todos los cobros / Sin facturar / Pendientes / Parciales / Cobradas», combinable con el de estado técnico. **Ambos viajan al server**: el técnico como `.eq('status')` sobre `orders` y, cuando hay filtro financiero, ambos se aplican sobre `v_order_financial_status`. El filtrado en React quedó reducido a la búsqueda de texto y a la prioridad, que no son financieras.

## 9. Detalle de solo lectura

Tarjeta «Estado financiero» con badge, total comprobado, cobrado directo, imputado desde CC (si lo hay), saldo pendiente, fechas de completado / cobro completo / último pago, enlace al comprobante y enlace a la cuenta corriente. El **crédito sin imputar se informa y no descuenta**: el aviso dice explícitamente que la asignación estará disponible desde el flujo de cuenta corriente. **Ninguna acción de imputar, distribuir o revertir** — un test lo verifica.

## 10. Permisos

Este lote es de **lectura**. La autoridad real es la DB: ambas vistas son `security_invoker`, así que un usuario sin acceso al negocio no recibe filas y la UI muestra **«No disponible»** en vez de importes. No se agregó ocultamiento por rol en el cliente, porque hoy `v_order_financial_status` no discrimina por rol dentro del negocio: **cualquier perfil activo que ya ve la orden ve su saldo**. Si el producto quiere un rol «tech» sin acceso a importes, eso es una policy nueva en la DB y no un `if` en React — queda anotado para U2.

## 11. Loading y error

- **Cargando:** ni badge ni importes. Un `$0` provisorio se lee como «no debe nada» y sería mentira.
- **Error o fila ausente:** badge «No disponible» y bloque explicativo, con los importes **ocultos**. Nunca `$0`, nunca «Cobrado», nunca «Sin facturar» como fallback.
- El error financiero **no tumba la lista**: los datos operativos de la orden siguen visibles.

## 12. Tests de componentes — 14, todos reales

Renderizan componentes reales y consultan el DOM; ninguno busca strings en archivos.

Cubiertos: **1-5** (los cuatro badges y la separación de ejes), **9** (error → «No disponible», jamás `$0`), **10** (loading sin estado falso), **13** (tokens de tema, sin hex), **14** (total, cobrado y saldo en el detalle), **15** (el crédito no imputado no mueve el badge ni el saldo), más fail-closed con `status=null` y ausencia de acciones de imputación.

**Pendientes** por depender de la página completa o de la UI de U2: **6, 7, 8** (filtros y reset de página — implementados y verificables a mano, pero sin test de la página montada), **11** (permisos), **12** (overflow móvil), **18-20** del listado original.

## 13. Guards

`guard-order-payment-status.mjs` sube a **15 fixtures** de self-test y suma cuatro reglas: saldo derivado restando en React, «Cobrado» por existir comprobante, filtro financiero aplicado después de descargar, y tests de componentes que apunten a un Supabase real o contengan un JWT.

**Dos hallazgos y una decisión:**

- **Deuda preexistente encontrada:** `OrderCostManagement.tsx` y `PaymentCard.tsx` derivan el saldo restando en React. No los introdujo este lote; quedan en baseline explícito y su refactor va con la UI de cobro (U2).
- **Regla retirada a propósito:** la que vigilaba `orders.comprobante_id` por texto marcaba `useOrders.ts` y `facturacionService.ts`, **ambos correctos** — confundía la columna homónima de `v_order_financial_status`, que sí es canónica, con la vía paralela de `orders`. Sin un parser real la regla grita en falso, y un guard que grita en falso se termina ignorando. La prohibición sigue documentada; el campo tiene 3 filas en producción y ningún consumidor nuevo.

## 14. Evidencia visual — **no capturada**

§12 pedía recorrido con datos sembrados en desktop/mobile × light/dark. **No lo hice.** La base local quedó reseteada y sin sesión sembrada, y montar el flujo de autenticación para el recorrido no entró en el presupuesto de este turno. Lo que sí está verificado, por test automático y no por inspección: el badge usa variables CSS de tema (lo que hace correcto el modo oscuro por construcción), el texto acompaña siempre al color, y el `aria-label` describe el estado. **El comportamiento responsive y el contraste real siguen sin verificarse visualmente** — es lo primero que hay que mirar antes de liberar.

## 15. Validación ejecutada

`tsc --noEmit` **0** · `lint:errors` **0** · `node --test` **572/572** · `test:components` **14/14** ·
`build` **OK** · `guards` **OK** (15/15 fixtures del nuevo) · secret scan **limpio** ·
`supabase/` **sin cambios** (sin migración, sin `db push`).

No repetí las suites SQL financieras: este lote no toca contratos ni tipos compartidos con la DB.

## 16. Riesgos

- **El recorrido visual no está hecho** (§14). Es el riesgo principal de este lote: hay decisiones de layout —una columna nueva en una tabla ya densa— que sólo se validan mirando.
- **`package-lock.json` cambió mucho** (+1172 líneas) por las devDependencies nuevas, y la instalación necesitó `--force` por el pin de rollup. El `build` pasa, pero conviene que CI lo confirme en Linux antes de liberar.
- **Bajo:** la columna «Cobro» agrega ancho a la tabla; en pantallas chicas puede empujar el layout. Sin verificación visual, no puedo afirmar que no lo haga.
- **Ninguno de datos:** el lote es de lectura y no agrega migraciones.

## 17. Alcance pendiente de P0-A.1U2

1. Modal de imputación: documentos abiertos, importes, distribución entre varios comprobantes, confirmación con resumen y llamada única a `allocate_account_payment_atomic` con idempotency key y bloqueo de doble submit.
2. Reversa desde UI, con historial de asignaciones y confirmación.
3. Manejo de conflicto concurrente en la UI («El saldo cambió mientras realizabas la operación…»).
4. Tests 6-8, 11, 12 y 16-20; refactor de `OrderCostManagement` y `PaymentCard` para sacarles el cálculo de saldo.
5. Decisión de producto sobre roles sin acceso a importes (§10), que se resuelve con policy, no con UI.

## 18. Recomendación

**GO a U2 con una condición previa: hacer el recorrido visual de este lote.**

El backend está cerrado y probado, y esta capa de lectura está implementada, tipada y con tests reales de comportamiento. Lo único que falta para dar U1 por terminado es mirar las cuatro combinaciones (desktop/mobile × light/dark) con datos sembrados y confirmar que la columna nueva no rompe la densidad de la tabla. Es corto, pero **no lo puedo dar por hecho sin haberlo visto**.

P0-B sigue **bloqueado y sin cambios**.
