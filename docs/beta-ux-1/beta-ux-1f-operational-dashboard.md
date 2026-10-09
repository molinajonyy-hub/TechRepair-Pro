# BETA-UX-1F — Inicio como centro operativo del taller

Base: `main` `e7298f7058c230483aea2f729548b060c36d09a9` (merge certificado de BETA-UX-1E, #174).

Rama: `claude/beta-ux-1f-operational-dashboard`.

**Sin migraciones, sin cambios en Edge Functions, sin `db push`, sin deploy, sin tocar producción.**
No cambia ninguna autoridad financiera, ninguna policy de RLS, ni Mercado Pago, ni ARCA. No se
rediseñó Finanzas. No se implementó CRM ni ORDERS-HISTORY-1.

---

## 1. Decisión de producto

> **DASHBOARD = operación. FINANZAS = dinero.**

Inicio era un tablero administrativo con números. Pasa a ser el lugar donde el taller mira qué
tiene que hacer hoy. Decisiones del owner que fija este lote:

| # | Decisión |
|---|---|
| 1 | **Nadie ve importes en Inicio.** Ni ganancia, ni cobrado, ni caja neta, ni deuda. Vale también para el dueño: no es un gate por capacidad, es que en Inicio no hay dinero. Para verlo están Finanzas y Caja. |
| 2 | **Caja y dólar salen del cuerpo de Inicio** y van a la barra superior global, a la derecha del buscador, como chips. La caja no muestra ningún monto. |
| 3 | **Las acciones tienen protagonismo** en el encabezado: Nueva Orden · Nuevo Comprobante · Gestionar Caja · Registrar gasto · Actualizar. No hay menú «Crear ▾». |
| 4 | **Se eliminan los «Accesos rápidos»**: duplicaban la navegación y quedaban fuera de la zona útil. |
| 5 | **Tareas pasa a ser protagonista.** Va a ser uno de los pilares del producto junto con el futuro CRM. |
| 6 | **Una sola guía de primeros pasos**: la canónica (`FirstStepsChecklist`). |
| 7 | Inicio muestra **sólo órdenes recientes**: sin pestañas de Comprobantes ni de Movimientos de Caja. |

## 2. Discovery (antes de editar)

Lo que se confirmó sobre `e7298f7`, punto por punto del pedido:

1. **Consultas financieras que disparaba Inicio.** `useDashboardStats` hacía 13 lecturas en paralelo
   y hasta 5 más en cadena: `business_finance_entries` (90 días), `v_finance_product_margin`,
   `comprobante_items` + `comprobantes` (90 días), `accounts.balance`, la RPC
   `get_order_financial_amounts`, `can_view_cogs` y tres `finance_dashboard_summary`; además dos
   conteos de `customers`. **Ninguna estaba gateada por capacidad**: salían también para un
   técnico (la RLS las rechazaba, pero el request existía). Con `finance`, se sumaban
   `useFinancialDashboard` (`comprobante_payments` ×2, `inventory` de stock bajo,
   `financial_movements`) y una lectura directa de `financial_movements`. La pestaña Comprobantes
   pedía la lista con `useComprobantes`.
2. **Otros consumidores de `useDashboardStats`.** `Reports.tsx` (usa sólo `popularDeviceTypes`),
   `DashboardNew.tsx` (página sin ruta) y `ModalCobro` (invalida su caché). **El hook no se tocó.**
3. **Por qué Inicio llamaba a `refreshInventoryDollarPrices`.** Es el **único** lugar del frontend
   que recalcula `sale_price` de los productos `linked_to_dolar` (precio en USD × cotización de
   venta). No se encontró nada del lado del servidor que lo haga: ni una Edge Function, ni un cron,
   ni un `UPDATE` en las migraciones. Corría al montar Inicio y cada 15 minutos
   **mientras Inicio seguía en pantalla**: un taller que deja la aplicación abierta en Órdenes o en
   el POS no actualizaba esos precios nunca.
4. **Permisos reales de cada CTA.** Nueva Orden → `orders_create` (lo que exigen la recepción y su
   RPC). Nuevo Comprobante → `comprobantes` (gatea `/comprobantes`). Gestionar Caja y Registrar
   gasto → `finance` (gatea `/caja` y `/expenses`). `/orders` no tiene gate de ruta. `/tasks` exige
   `orders` **y** la feature de plan `tasks`.
5. **`TopHeader` en mobile.** No existe: por debajo de 1024 px `.desktop-topheader-wrapper` es
   `display: none` y el shell usa `MobileTopBar` (menú, logo + título, tema). El componente igual
   queda montado.
6. **`FirstStepsChecklist` ya se auto-oculta**: no se dibuja si está cargando, descartado, sin pasos
   que el actor pueda hacer, o con todos hechos. Filtra por capacidad. Se dibujaba **arriba** del
   encabezado, y además Inicio tenía su propia bienvenida («¡Bienvenido a TechRepair Pro!»).
7. **«Nueva tarea»** navega a `/tasks` con `state: { openCreate: true }`; `Tasks.tsx` lo consume una
   vez y limpia el state.
8. **Órdenes recientes**: `.order('created_at', desc).limit(5)`.

## 3. Jerarquía: antes → después

| Antes | Después |
|---|---|
| Primeros pasos (arriba del encabezado) | **Encabezado** «Inicio · Tu taller hoy» + acciones |
| Encabezado «Resumen general del sistema…» | **Primeros pasos** — sólo si hay algo pendiente que el actor pueda hacer |
| Mis Tareas (widget; tira de 60 px si no había tareas) | **Hoy** — Órdenes activas · Listas para entregar · Esperando aprobación |
| Franja de caja a todo el ancho | **Mis tareas** — a todo el ancho, con resumen y hasta 5 tareas |
| Órdenes activas · Clientes · **Ganancia Real Hoy** · tarjeta del **Dólar** | **Órdenes recientes** — 5, tabla en escritorio y tarjetas en mobile |
| **Cobrado en caja** · **Caja neta** · «Finanzas →» | |
| **Accesos rápidos** (6 tarjetas) | |
| Pestañas Órdenes / **Comprobantes** / **Movimientos Caja** | |

Barra superior (escritorio, global):

```
[ Buscar clientes, órdenes… ]      [ ● Caja abierta  desde 09:20 ] [ USD $1.556 ↻ ] [Reconectar] [Tema] [🔔]
```

## 4. Consultas que dejaron de ocurrir al entrar a `/dashboard`

| Fuente | Quién la pedía |
|---|---|
| `business_finance_entries` | `useDashboardStats` |
| `v_finance_product_margin` | `useDashboardStats` |
| `comprobante_items` (+ `comprobantes`) | `useDashboardStats` |
| `accounts` (saldos de cuenta corriente) | `useDashboardStats` |
| RPC `get_order_financial_amounts` | `useDashboardStats` |
| RPC `can_view_cogs` + 3 × RPC `finance_dashboard_summary` | `useDashboardStats` |
| `customers` (2 conteos) | `useDashboardStats` |
| `orders`: completadas hoy, candidatas a cobro, 100 completadas para tiempos | `useDashboardStats` |
| `comprobante_payments` (semana y mes) | `useFinancialDashboard` |
| `inventory` (conteo de stock bajo) | `useFinancialDashboard` |
| `financial_movements` (por caja) ×2 | `useFinancialDashboard` y el propio `Dashboard.tsx` |
| `comprobantes` (lista) | `useComprobantes`, pestaña Comprobantes |

Lo que Inicio pide ahora: seis conteos exactos y una lista de `orders`
(`useOperationalDashboardStats`), dos lecturas de `tasks` (`taskService`) y la RPC
`get_my_first_steps`. Nada más.

Dos defectos del cálculo viejo que el hook nuevo no hereda:

- **«Órdenes activas» se truncaba.** Los estados se contaban en el cliente sobre
  `select('status')`, que la API corta en 1.000 filas; el total salía de un `count` exacto. Con más
  de 1.000 órdenes, «activas = total − completadas − canceladas» restaba de un total exacto una
  cantidad truncada. Ahora cada número es un `count: 'exact', head: true`.
- **«Nuevas hoy» cortaba en la medianoche UTC** (21:00 de Argentina). Ahora corta a las 00:00 de
  Argentina (`businessDayStartInstant`).

### Qué queda en Finanzas

Todo. `useDashboardStats`, `useFinancialDashboard`, `financialMetricsService`, las vistas
`v_finance_*` y las RPC no se modificaron. Ganancia, cobrado, caja neta, márgenes y deuda se ven en
`/finance` y `/caja`, con las mismas capacidades de siempre.

## 5. Caja y dólar en el shell

### Caja

`CajaStatusChip` dice una sola cosa: si hay una caja abierta (y desde qué hora). Nunca un importe.
El estado no depende del color: punto lleno / aro vacío y texto.

La autoridad sale de `CajaContext`, que ya distinguía **conocer** el estado de **gestionar** la caja.
Se expuso esa primera condición —la misma que decide si el provider lee `cajas`— como
`canSeeCajaStatus`, para que el chip no la reescriba:

| Actor | `canSeeCajaStatus` | `canUseCaja` | Qué ve |
|---|---|---|---|
| Con `finance` (owner, admin, cashier, override) | sí | sí | Chip **enlace** a `/caja` |
| Con `comprobantes` sin `finance` (sales, manager) | sí | no | Chip **informativo**: ni enlace ni botón |
| Sin ninguna (tech, viewer) | no | no | Nada. Tampoco se consulta `cajas` |

Mientras la primera lectura no vuelve el chip no se dibuja: «Caja cerrada» antes de saberlo sería un
estado falso.

### Dólar

`DollarRateBadge variant="compact"` ya existía; se reescribió su presentación con tokens de tema
(pintaba el número con un hex fijo por fuente; `#22c55e` sobre blanco da ~2,2:1, calculado). La
fuente y la antigüedad van en el
título del chip; un valor que no es de ahora se marca con un ícono con nombre accesible.

**Una sola lectura.** Antes cada badge pedía la cotización al montarse y, además, Inicio la pedía en
un efecto propio: dos lecturas en carrera por visita. Ahora el estado vive en `useDollarRate`
(`useSyncExternalStore`): se lee una vez por negocio, lo comparten todos los que lo muestran y se
renueva cada 15 minutos mientras alguien lo mire.

**El reprecio del inventario.** Se movió a `useInventoryDollarPriceSync`, montado en `MainLayout`.
Corre una vez por cada lectura terminada de la cotización —la inicial, la periódica y la manual—,
en cualquier pantalla. **La fórmula y la fuente no cambiaron**: es la misma función del servicio
(`refreshInventoryDollarPrices`), que no se tocó.

Efecto observable: los precios atados al dólar ya no dependen de que alguien abra Inicio, y también
siguen a la cotización cuando el usuario la actualiza a mano desde el chip (antes ese botón
actualizaba el número y no los precios).

### Mobile

`TopHeader` no se ve por debajo de 1024 px y `MobileTopBar` no admite más controles en una línea.
Los dos chips van en una fila propia debajo de la barra, **sólo en Inicio** —que es donde vivían—:
en las pantallas de trabajo (recepción, POS, listas) el alto es del contenido. El área táctil es de
44 px; la píldora que se ve mide 32.

## 6. Acciones y actores

Cada acción usa la capacidad canónica de su destino, nunca el nombre del rol:

| Acción | Capacidad | Estilo |
|---|---|---|
| Nueva Orden | `orders_create` | Principal: gradiente AA, 44 px (48 en mobile) |
| Nuevo Comprobante | `comprobantes` | Índigo plano (`btn-indigo-aa`) · `state: { openNew: true }` |
| Gestionar Caja | `canUseCaja` (`finance`) | Contorno |
| Registrar gasto | `finance` | Rojo semántico, variante `danger` (`btn-danger-aa`) |
| Actualizar | — | Sólo ícono |

| Actor | Acciones | Caja en la barra | Importes en Inicio |
|---|---|---|---|
| Owner / admin / cashier | las cuatro | estado + enlace | ninguno |
| Sales / manager | Nueva Orden, Nuevo Comprobante | estado, sin enlace | ninguno |
| Tech | Nueva Orden | no existe | ninguno |
| Viewer | — | no existe | ninguno |

«Actualizar» refresca órdenes, tareas, el estado de la caja y la cotización. No recarga el
navegador y no vuelve a introducir lecturas financieras.

## 7. Tareas como pilar

`DashboardTasks` dejó de ser un widget:

- bloque a todo el ancho, justo debajo de «Hoy», con encabezado propio («Mis tareas · Lo que
  necesita tu atención») y dos acciones: **Nueva tarea** y **Ver todas**;
- **resumen** Vencidas · Para hoy · Pendientes. «Completadas» sigue en el módulo. Vencidas se pinta
  de rojo sólo si hay alguna;
- **hasta 5 tareas** activas: título, vencimiento, prioridad. Una vencida se reconoce sin leer
  (filete, ícono y la palabra «Vencida»);
- sin tareas dice «Todo al día» y **conserva su lugar**: no se achica a una tira.

Lo que **no** cambió: `taskService` sigue siendo la única autoridad; completar es un tap, valida el
checklist en el servicio y un fallo se muestra en la fila; un error de lectura se dice (con
«Reintentar») en vez de verse como «sin tareas»; auto-refresh cada 30 s; «Nueva tarea» abre el
formulario real del módulo.

**`TaskSummary.dueToday`.** Campo nuevo, sin migración y sin consulta adicional: sale de las mismas
filas (`status`, `due_date`). Cuenta las tareas activas cuyo `due_date` es la **fecha de negocio
argentina** (`todayAR()`), no la UTC: a las 23:30 de Argentina el día UTC ya es mañana.

**Preparado para CRM, sin CRM.** La fila es deliberadamente genérica —lo que tiene cualquier tarea,
venga de donde venga—. No hay pestaña, ni leads, ni tipos de tarea, ni un badge «CRM»: hoy no existe
un origen que mostrar y no se inventó uno.

## 8. Órdenes recientes

Cinco, sin importes. Columnas: Orden · Cliente · Dispositivo · Estado · Fecha. La fila entera abre
el detalle y el número es además un enlace real (para el teclado). Se quitó el ojo.

En mobile son tarjetas (`CompactList`): #orden + estado · cliente · dispositivo · fecha. Tabla y
tarjetas son dos presentaciones del mismo dato y el CSS elige cuál se ve (corte en 768 px, como en
BETA-UX-1D).

El estado usa la etiqueta canónica de `types/orderStatus.ts`. `AppStatusBadge type="order"`, que
usaba Inicio, no conoce `ready_delivery`, `waiting_approval` ni `waiting_payment`: mostraba la clave
cruda justo en los estados que ahora cuentan los indicadores.

Los tres indicadores de «Hoy» llevan a `/orders` **sin filtro**: el filtro de estado de esa pantalla
es estado local y no recibe nada por navegación. No se inventó un handoff en este lote.

## 9. Contraste

Todo lo nuevo usa tokens de tema. Regla del bloque: el texto es `--text-primary` o
`--text-secondary`. `--text-tertiary` y `--text-subtle` quedan fuera: sobre el fondo de la página y
sobre cualquier hover no llegan a 4,5:1 en tema claro.

Dos variantes locales de botón, con el mismo criterio que `btn-primary-aa` en 1E (las reglas
globales **no se tocan**):

| Variante | Por qué | Reposo | Hover |
|---|---|---|---|
| `.btn-fill-indigo.btn-indigo-aa` | el extremo `#6366f1` del gradiente mide 4,47 con blanco | 6,29 | 7,90 |
| `.btn-danger.btn-danger-aa` | `--error` sobre `--error-subtle` mide ~4,1 en claro | 5,46 claro · 6,4 oscuro | 5,00 · 5,9 |

`btn-danger-aa` no inventa un rojo: usa `--order-badge-pending-fg`, el par por tema que ya existía
para los badges de cobro.

Medido en Chromium sobre píxeles pintados (`paintedContrastOf`), con backend simulado: **281
medidas** entre claro y oscuro, escritorio y 375 px, reposo y hover. Ninguna por debajo de 4,5:1.
Detalle en `evidence-1f/capture-report.txt`.

## 10. Estructura mobile (375 × 812)

```
[≡] [logo] Inicio                [tema]      ← MobileTopBar (sin cambios)
[● Caja abierta desde 09:20] [USD $1.556 ↻]  ← fila de utilidades, sólo en Inicio
[▦] Inicio                           [↻]
    Tu taller hoy
[          + Nueva Orden               ]     ← 48 px, todo el ancho
[ Nuevo      ] [ Gestionar ] [ Registrar ]   ← un tercio cada una
[ Comprobante] [ Caja      ] [ gasto     ]
[  9 activas |  2 listas  |  1 esperando ]   ← una fila de tres
[ Mis tareas …                          ]
[ Órdenes recientes (tarjetas) …        ]
```

Sin desborde horizontal a 320, 375, 390, 430, 768, 1024, 1280 y 1440 px. Todo lo interactivo mide
44 px por debajo de 1024.

## 11. Fuera de alcance, para que no se pierda

### ORDERS-HISTORY-1 · Histórico + búsqueda + paginación server-side

Bug real confirmado en el discovery. **No se arregló en este lote.**

- `src/hooks/useOrders.ts:78` — `PAGE_SIZE = 50`, aplicado como `.limit(PAGE_SIZE)` (líneas 135 y
  156), sin `range` ni página.
- `src/pages/Orders.tsx` no tiene página, ni Anterior / Siguiente.
- `smartSearch` (línea 85) busca **dentro de esas 50** órdenes ya cargadas.

Consecuencia: una orden que no esté entre las 50 más recientes no se puede listar ni encontrar desde
Órdenes. Con el uso real de un taller eso pasa en semanas. Debe ir **alto en el roadmap pre-beta**.

### StockRepairTool

Sigue expuesto. No está en Inicio ni en `TopHeader`, así que **no se tocó**:

- se monta al pie de Inventario: `src/pages/Inventory.tsx:3265`;
- gate de la ruta: capacidad `inventory`;
- gate propio: `['owner', 'admin'].includes(profile?.role)` — por **nombre de rol**, no por
  capacidad (`src/components/inventory/StockRepairTool.tsx:35`).

Queda para un micro-lote propio decidir si sale de la UI de beta.

## 12. Hallazgos que quedan a decisión del owner

1. **`useFinancialDashboard` se quedó sin consumidores.** Inicio era el único. El hook y
   `financialDashboardLoaders` siguen en el repo con sus tests; hoy son código sin uso.
2. **Reportes monta `useDashboardStats` entero** (las 13+ lecturas financieras) para leer un solo
   campo, `popularDeviceTypes`, que el hook devuelve siempre vacío.
3. **El bloque de Tareas no mira el plan.** `/tasks` exige la feature `tasks`; el bloque de Inicio se
   muestra igual (ya era así y se conservó). En un plan sin Tareas, «Nueva tarea» y «Ver todas»
   llevan a la pantalla de upgrade.
4. **El reprecio de inventario es del navegador.** `refreshInventoryDollarPrices` hace un `UPDATE`
   por producto, desde el cliente, con cualquier actor que tenga la aplicación abierta. Este lote
   sólo le cambió el ciclo de vida. El contrato de cotización sigue siendo discovery abierto.
5. **La cotización se pide en cada carga de la aplicación**, no sólo en Inicio: es consecuencia de
   que el chip sea global. El stack local de E2E no tiene esa Edge Function; ver §13.
6. **«Vencida» en Inicio usa el reloj del navegador** (`isOverdue`, dos copias: `taskService` y el
   bloque de Inicio); «para hoy» usa la fecha argentina. La página de Tareas ya usa la fecha
   argentina para las dos cosas (`taskGrouping`, TASKS-V2-1). En un navegador con hora de Argentina
   coinciden. `isOverdue` no se tocó.
7. **Deuda global de contraste**, calculada con los tokens y no tocada: `.btn-danger` en claro
   (~4,1:1; su hover no se midió); `.page-subtitle` usa `--text-subtle` (entre 2,4 y 2,8:1 según el
   tema; para Inicio se pisó localmente); `--text-tertiary` sobre el fondo de página en claro
   (4,42:1).
8. **Tablet (768–1023 px).** El enlace del número de orden dentro de la tabla mide 17 px de alto; la
   fila entera (48 px) es la que se toca.
9. **La fila de utilidades de mobile es sólo de Inicio.** Hacerla global es un cambio de una línea en
   `MainLayout`, a costa de ~50 px en cada pantalla.

## 13. E2E y la cotización

El chip global hace que el shell pida la cotización en cada carga. El stack local de CI no levanta el
edge runtime, así que ese request devolvería un 5xx en **todas** las pantallas, y cinco specs que
exigen «ningún request fallido» o «consola limpia» se pondrían en rojo por algo que no miden.

No se agregó una excepción a la lista de fallos tolerados de cada spec. `helpers/dollarRate.ts`
responde lo que la función responde cuando no pudo cotizar —200 con `{ error }`—, por patrón exacto
de las dos funciones: un 5xx de cualquier otra sigue viéndose. Se registra en el fixture base de m7 y,
con una línea, en los cuatro specs que no lo usan (`search-pos-visual`, `pos-mobile-layout`,
`charts-l1-visual`, `finance-caja-visual`).

## 14. Gates

**Disco local.** `C:` tenía 13,9 GB libres al empezar (bajó a 5,4 GB durante la sesión por un stack
de Docker que esta sesión no levantó, y cerró en ~10 GB). Por debajo de 15 GB: **no se levantó
Docker, no se corrió `m7-local` y no se corrió ningún E2E.** La verificación en navegador se hizo con
backend simulado (§15).

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint src --quiet` | 0 errores (sin warnings en los archivos tocados) |
| `test:beta-ux-1f` | 13 archivos · 392 tests |
| Suite completa de componentes | 136 archivos · 3.030 / 3.030 en la última corrida. Ver la nota de abajo |
| `test:unit` | 1.215 / 1.215 |
| `vite build` (con el entorno de CI) | OK |
| Guards estáticos | 19 en verde (ui-governance, no-real-data, credenciales, finance-writes, ci-e2e, first-steps, dollar-functions, order-payment-status, prebeta-p1, charts-l1, stock ×2, mobile-session, pwa, onboarding, customer-core, edge-cors, support-contact, tenant-isolation) |
| Controles negativos | 23 / 23 detectados; árbol idéntico al terminar |
| Verificación en navegador (backend simulado) | 19 escenarios · 281 medidas de contraste · 0 desbordes |
| **E2E `@beta-ux-1f`** (22 tests) | **pendiente por disco local** — lo valida CI |
| **`m7-local` vecinos** | **pendiente por disco local** — los valida CI |

**Un test intermitente, ajeno al lote.** `orderIntakeMobile › scanner cross-browser ›
enumerateDevices vacío pero getUserMedia OK` falló en 3 de las 4 corridas completas de la suite en
esta máquina y pasó en la cuarta; aislado pasa siempre (8/8), y en la base (`e7298f7`) la corrida
completa dio 2.918 / 2.918. Monta sólo `BarcodeScannerDialog`: no toca nada de este lote. Depende
del tiempo de carga de la máquina, y la suite nueva suma carga a la corrida completa. CI lo corre
dentro de `test:mobile2a`, con cuatro archivos.

### Controles negativos

`evidence-1f/negative-controls.mjs` rompe a propósito cada invariante, corre la suite, exige que
falle **en el test que corresponde**, restaura el archivo y compara el árbol byte a byte. Los diez
que pedía el lote y trece más (autoridad de caja, red, estados canónicos, fecha argentina, doble
lectura de la cotización). Salida en `evidence-1f/negative-controls.txt`.

Escribirlos encontró tres agujeros en la primera versión de la suite, ya corregidos:

- el Supabase simulado anotaba la tabla al **resolver** la consulta: una consulta con un operador que
  el simulador no conocía explotaba antes y no dejaba rastro. Ahora anota en el `from()`;
- un hook con caché de módulo consulta sólo en su primer montaje, que podía no ser el del test de
  red. Se agregó un contrato sobre **todos** los montajes del archivo;
- «usa la variante `danger`» pasaba por substring con `btn-danger-aa`. Ahora compara clases exactas.

## 15. Evidencia

Capturas con sesión falsa y backend simulado (`evidence-1f/capture-mocked.mjs`): `VITE_SUPABASE_URL`
apunta a un puerto muerto y cada request se responde en el navegador. **No son capturas contra la
base**; el CSS, el layout y el código son los reales.

| Archivo | Qué muestra |
|---|---|
| `dashboard-owner-desktop-light.png` | Dueño, 1440 px, claro |
| `dashboard-owner-desktop-dark.png` | Dueño, 1440 px, oscuro |
| `dashboard-tech-desktop.png` | Técnico: una acción, sin chip de caja |
| `dashboard-owner-mobile.png` | Dueño, 375 px |
| `dashboard-new-business.png` | Negocio nuevo: una guía, ceros reales, estados vacíos |
| `top-header-utilities.png` | La barra superior con Caja y dólar |

El spec de E2E puede regrabarlas contra la base real con `BETA_UX_1F_EVIDENCE=1`.

## 16. Archivos

**Nuevos**

- `src/hooks/useOperationalDashboardStats.ts` — lo que Inicio lee de la operación.
- `src/hooks/useDollarRate.ts` — cotización compartida + reprecio en el shell.
- `src/components/layout/CajaStatusChip.tsx`
- `tests/components/betaUx1fDashboard.test.tsx`
- `tests/e2e/m7/dashboard-day-one.spec.ts` · `tests/e2e/setup/seedDashboardFixture.ts` ·
  `tests/e2e/helpers/dollarRate.ts`

**Modificados**

- `src/pages/Dashboard.tsx` — reescrito.
- `src/components/tasks/DashboardTasks.tsx` — presentación.
- `src/components/ui/DollarRateBadge.tsx` — lee del estado compartido; compacto con tokens.
- `src/components/layout/TopHeader.tsx` · `src/layouts/MainLayout.tsx`
- `src/contexts/CajaContext.tsx` — expone `canSeeCajaStatus`.
- `src/services/taskService.ts` — `dueToday`, `isTaskDueToday`.
- `src/ui/components/AppPageHeader.tsx` — `actionsClassName` (opcional; sin él, igual que antes).
- `src/index.css` — bloque BETA-UX-1F, antes de los de 1E / 1D / 1C.
- Tests que fijaban el Inicio viejo, llevados al contrato nuevo: `cajaCapabilityGate`,
  `rbacCapabilities`, `prebeta3a0Guardrails`, `tasksHonestStates`,
  `tests/unit/financialDashboardResilience`, `scripts/p0p6-negative-gates.mjs`.
- E2E: `m7/fixtures.ts` y cuatro specs (§13).
- `package.json` (`test:beta-ux-1f`) · `.github/workflows/ci.yml`.
