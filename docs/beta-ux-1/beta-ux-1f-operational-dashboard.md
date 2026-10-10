# BETA-UX-1F — Inicio como centro operativo del taller

Base: `main` `e7298f7058c230483aea2f729548b060c36d09a9` (merge certificado de BETA-UX-1E, #174).

Rama: `claude/beta-ux-1f-operational-dashboard`.

**Sin migraciones, sin cambios en Edge Functions, sin `db push`, sin deploy, sin tocar producción.**
No cambia ninguna autoridad financiera, ninguna policy de RLS, ni Mercado Pago, ni ARCA. No se
rediseñó Finanzas. No se implementó CRM ni ORDERS-HISTORY-1.

> **Microfix sobre `a528eee` (mismo PR #175).** Tres correcciones después de la revisión del owner y
> de la primera corrida del E2E en GitHub: el bloque de Tareas comparte el gate de `/tasks`; el
> shell muestra la cotización pero **no reprecia inventario** (ese efecto volvió a ser sólo de
> Inicio); y la fila de acciones de mobile quedaba despareja. El detalle está en §17; las secciones
> de abajo ya describen el estado corregido.

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
(`useSyncExternalStore`): se lee una vez por negocio y lo comparten todos los que lo muestran.

**Dos efectos distintos, que no se acoplan.**

| Efecto | Dónde vive | Cuándo corre |
|---|---|---|
| Leer, mostrar y refrescar la cotización | el **shell** (`useDollarRate`, `TopHeader`, fila de mobile) | al cargar la aplicación, con el botón del chip y cada 15 minutos |
| Repreciar el inventario atado al dólar | **sólo Inicio** (`useInventoryDollarPriceSync`, montado en `Dashboard`) | una vez por lectura efectiva, mientras Inicio está montado |

Que la cotización cambie no reprecia nada por sí solo. `MainLayout`, `TopHeader`, `DollarRateBadge`
y `CajaStatusChip` no conocen el inventario: navegar por la aplicación, dejarla abierta en Órdenes o
tocar «Actualizar cotización» fuera de Inicio **no escribe un solo producto**.

**El reprecio heredado, acotado a Inicio.** Antes de 1F, Inicio leía la cotización al montarse y cada
15 minutos, y después de cada lectura con precio de venta llamaba a `refreshInventoryDollarPrices`.
Ese comportamiento se conserva en el mismo lugar, con estas reglas:

- **no hay un segundo pedido de cotización**: Inicio usa la lectura que ya hizo el shell;
- **como máximo un reprecio por lectura efectiva** (una lectura terminada que trae precio de venta):
  la inicial, la periódica y la manual, mientras Inicio está montado;
- una lectura ya aplicada **no se repite al volver a entrar** a Inicio. Es la única diferencia con
  el comportamiento viejo, que repreciaba en cada montaje: sin una lectura nueva no hay nada nuevo
  que aplicar;
- una lectura hecha con Inicio desmontado no reprecia en ese momento; si es la vigente cuando Inicio
  se monta, se aplica ahí, una sola vez.

La fórmula y la fuente no cambiaron: es la misma función del servicio, que no se tocó.

**El timer de 15 minutos.** Es del shell y sólo refresca lo que se muestra. No fuerza la fuente: le
pregunta al servicio (`refreshDollarRate(businessId, false)`) y es el caché del servicio —15
minutos— el que decide si se consulta la fuente, igual que la lectura periódica que tenía Inicio.
Como el caché se llena cuando la lectura termina, al dispararse el intervalo suele seguir fresco y la
fuente se consultaría uno de cada dos ciclos (leído del código; no se midió con un reloj real).
Forzar queda para una acción explícita del usuario (el botón del chip, «Actualizar» en Inicio). El
timer no reprecia inventario.

**Lo que el servicio escribe al leer (auditado, no modificado).** Cuando `dollarRateService` consulta
la fuente —auto-update activo y caché vencido, o lectura forzada— guarda el valor obtenido: un
`upsert` en `exchange_rates`, un `insert` en `dollar_rate_history` y un `update` de
`business_settings.last_dollar_*`. Es persistencia de la **cotización**, no de inventario, y es
anterior a 1F. Lo que 1F cambió es desde dónde ocurre: al mostrarse en el shell, la primera lectura
de cada carga de la aplicación sale de cualquier pantalla (antes, sólo de Inicio). Medido en el
navegador: tres escrituras de cotización por cada consulta a la fuente, cero de inventario fuera de
Inicio (`evidence-1f/verify-microfix.txt`).

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
navegador y no vuelve a introducir lecturas financieras. La cotización que vuelve es una lectura
nueva: como Inicio está montado, el reprecio heredado la aplica una vez (§5).

## 7. Tareas como pilar

`DashboardTasks` dejó de ser un widget:

- bloque a todo el ancho, justo debajo de «Hoy», con encabezado propio («Mis tareas · Lo que
  necesita tu atención») y dos acciones: **Nueva tarea** y **Ver todas**;
- **resumen** Vencidas · Para hoy · Pendientes. «Completadas» sigue en el módulo. Vencidas se pinta
  de rojo sólo si hay alguna;
- **hasta 5 tareas** activas: título, vencimiento, prioridad. Una vencida se reconoce sin leer
  (filete, ícono y la palabra «Vencida»);
- sin tareas dice «Todo al día» y **conserva su lugar**: no se achica a una tira.

**El bloque comparte el gate de `/tasks`.** Se dibuja sólo para quien puede entrar al módulo: la
capacidad `orders` **y** la feature de plan `tasks`, el mismo contrato que la ruta (`App.tsx`), el
Sidebar y la navegación móvil. Tareas no tiene una capacidad propia y no se inventó una; tampoco se
mira el nombre del rol. La decisión vive en `useTasksAccess`, que no consulta nada propio
(`usePermissions` + `useSubscription`, con su caché).

Cuando Tareas no está disponible el bloque **no se monta**: no pide `tasks`, `task_items` ni
`task_history` —tampoco al tocar «Actualizar»—, no deja un hueco y las órdenes recientes suben a su
lugar. No queda ningún «Nueva tarea» ni «Ver todas» que termine en la pantalla de «mejorá tu plan».

Una diferencia deliberada con el guard de la ruta: mientras el plan se está leyendo, la ruta deja
pasar (`useSubscription` resuelve sin datos como un trial optimista) y el bloque espera. Como pide
`tasks` apenas se monta, abrirlo a ciegas sería pedirle tareas al servidor para un negocio cuyo plan
no las incluye. Con el plan confirmado, la decisión es la de la ruta; si la lectura del plan termina
sin datos, el bloque queda cerrado.

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

Las tres secundarias comparten **fila y alto** (`align-items: stretch`). Según la fuente y el ancho,
«Nuevo Comprobante» ocupa dos renglones y «Gestionar Caja» uno; con la fila centrada el botón más
bajo quedaba descolgado. Ver §17.

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

### DOLLAR-PRICE-SYNC-1 · reprecio de inventario con autoridad del servidor

Deuda técnica registrada. **No se resuelve en BETA-UX-1F**: este lote sólo devolvió el reprecio al
lugar donde estaba (Inicio) y lo separó de la lectura de la cotización.

Estado actual de `refreshInventoryDollarPrices` (`src/services/dollarRateService.ts`):

- corre **en el navegador**, con la sesión de quien tenga Inicio abierto;
- lee todos los productos `linked_to_dolar` del negocio y hace **un `UPDATE` por producto**
  (`sale_price`, `exchange_rate_used`, `updated_at`);
- no compara antes: vuelve a escribir aunque la cotización efectiva sea la misma;
- es un bucle de escrituras sueltas, sin transacción: un corte a mitad dejaría productos con
  cotizaciones distintas, y dos pestañas en Inicio lo correrían en paralelo (leído del código, no
  reproducido);
- no se encontró nada del lado del servidor que lo haga (ni Edge Function, ni cron, ni trigger).

Recomendación a futuro, sin compromiso de diseño: reprecio con autoridad del servidor, en lote, y
sólo cuando cambia la cotización efectiva. Explícitamente **fuera** de 1F: convertirlo en RPC,
`UPDATE` en lote server-side, triggers, un scheduler en Edge, mover la autoridad al backend,
rediseñar `exchange_rates` o eliminar el `UPDATE` por producto.

Relacionado, mismo discovery abierto (contrato de cotización del dólar): la persistencia de la
cotización también la hace el navegador (§5).

## 12. Hallazgos que quedan a decisión del owner

1. **`useFinancialDashboard` se quedó sin consumidores.** Inicio era el único. El hook y
   `financialDashboardLoaders` siguen en el repo con sus tests; hoy son código sin uso.
2. **Reportes monta `useDashboardStats` entero** (las 13+ lecturas financieras) para leer un solo
   campo, `popularDeviceTypes`, que el hook devuelve siempre vacío.
3. ~~El bloque de Tareas no mira el plan.~~ **Corregido en el microfix** (§7, §17): comparte el gate
   de `/tasks`.
4. **El reprecio de inventario es del navegador.** `refreshInventoryDollarPrices` hace un `UPDATE`
   por producto, desde el cliente. El microfix lo devolvió a Inicio —como estaba antes de 1F— y no
   le cambia nada más. Queda registrado como deuda **DOLLAR-PRICE-SYNC-1** (§11). El contrato de
   cotización sigue siendo discovery abierto.
5. **La cotización se pide en cada carga de la aplicación**, no sólo en Inicio: es consecuencia de
   que el chip sea global. Con eso, la **persistencia de la cotización** que hace el servicio en cada
   consulta a la fuente (`exchange_rates`, `dollar_rate_history`, `business_settings`) también sale
   de cualquier pantalla. No es inventario y el servicio no se tocó, pero es un cambio de dónde
   ocurre esa escritura respecto de antes de 1F: a decisión del owner si es aceptable hasta
   DOLLAR-PRICE-SYNC-1. El stack local de E2E no tiene esa Edge Function; ver §13.
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
10. **`AppTabs` quedó con un solo consumidor**: el detalle de una tarea (`TaskDetailDialog`), que es
    un diálogo y no una ruta. El E2E `tab-contrast` medía ese componente en Inicio; hoy mide las
    clases `.tab` en Ofertas y Configuración (§17). No hay un E2E de contraste sobre `AppTabs` en
    una superficie viva.
11. **El caso «plan sin Tareas» no tiene E2E contra la base.** El negocio E2E es estado compartido
    por toda la suite y cambiarle el plan dentro de un test afectaría a los demás. Lo cubren los
    tests de componentes (con los guards reales de la ruta) y la verificación en navegador con
    backend simulado.

## 13. E2E y la cotización

El chip global hace que el shell pida la cotización en cada carga. El stack local de CI no levanta el
edge runtime, así que ese request devolvería un 5xx en **todas** las pantallas, y cinco specs que
exigen «ningún request fallido» o «consola limpia» se pondrían en rojo por algo que no miden.

No se agregó una excepción a la lista de fallos tolerados de cada spec. `helpers/dollarRate.ts`
responde lo que la función responde cuando no pudo cotizar —200 con `{ error }`—, por patrón exacto
de las dos funciones: un 5xx de cualquier otra sigue viéndose. Se registra en el fixture base de m7 y,
con una línea, en los cuatro specs que no lo usan (`search-pos-visual`, `pos-mobile-layout`,
`charts-l1-visual`, `finance-caja-visual`).

### Primera corrida del E2E en GitHub (`a528eee`)

El spec se había escrito sin poder ejecutarlo. La corrida de `E2E Smoke Tests` sobre `a528eee`
(run 38002955740) dio **351 verdes y 10 rojos**, en dos grupos:

| Tests | Error | Causa | Qué se hizo |
|---|---|---|---|
| `dashboard-day-one.spec.ts:552` · «375×812 · light / dark · misma jerarquía, composición adaptada» (2) | `las secundarias no están en una fila` — esperado 1, recibido 2 | **Defecto real del producto.** «Nuevo Comprobante» y «Registrar gasto» ocupaban dos renglones y «Gestionar Caja» uno; la fila centraba y el botón más bajo quedaba descolgado (8 px, medido después en local) | Se corrigió el **CSS** (`align-items: stretch`). El spec no se aflojó: se reforzó (exige además el mismo alto, y lo mide también a 390 y 430) |
| `tab-contrast.spec.ts:78` · «Dashboard · AppTabs · {320, 390, 430, 1440}px · {light, dark}» (8) | `expect(locator('.tab-active:visible')).toBeVisible()` — `element(s) not found` | **Contrato que cambió, no un defecto.** El spec medía las pestañas de Inicio, que este lote quitó por decisión de producto (§1.7). No se había detectado porque `m7-local` no se pudo correr en local | Se sacó `/dashboard` de las superficies de ese spec. Siguen Ofertas y Configuración (16 tests) |

Los otros 20 tests de `@beta-ux-1f` pasaron en esa corrida, incluidos los de los actores reales
(técnico y vendedor) y el contrato de red.

Sobre el primer grupo, lo que mostró la verificación posterior: no era un efecto de las fuentes de
Linux. Con las de Windows, a 375 px los tres rótulos caen en dos renglones y la fila queda pareja
—por eso el lote original no lo vio—, pero a **390, 412, 430 y 480 px** ya quedaba despareja
(altos 66 / 51 / 51). El lote original había medido esa fila sólo a 375.

## 14. Gates

Los números de esta sección son los del **microfix** (head posterior a `a528eee`).

**Disco local.** En el lote original `C:` estuvo siempre por debajo de 15 GB (13,9 → 5,4 → ~10) y no
se levantó Docker. En el microfix arrancó en 17,8 GB con Docker Desktop encendido y **dos stacks de
otras sesiones** corriendo; durante el trabajo bajó a 14,4 GB sin que esta sesión levantara nada. No
se sumó un tercer stack: **no se corrió ningún E2E en local.** La verificación en navegador volvió a
hacerse con backend simulado (§15) y el E2E queda a cargo de GitHub (§13).

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint src --quiet` | 0 errores (sin warnings en los archivos tocados) |
| `test:beta-ux-1f` | 13 archivos · 418 tests (392 del lote + 26 del microfix) |
| Suite completa de componentes | 136 archivos · 3.055 / 3.056. El único rojo es el intermitente de abajo |
| `test:unit` | 1.215 / 1.215 |
| `vite build` (con el entorno de CI) | OK |
| Guards estáticos | 21 en verde: los 19 del lote (ui-governance, no-real-data, credenciales, finance-writes, ci-e2e, first-steps, dollar-functions, order-payment-status, prebeta-p1, charts-l1, stock ×2, mobile-session, pwa, onboarding, customer-core, edge-cors, support-contact, tenant-isolation) más product-search y visual-evidence. `guard:realtime-notifications`, que se probó de más, ya falla en la base por un conteo de `.single()` que este lote no cambia, y no corre en CI |
| Controles negativos | 35 / 35 detectados (23 del lote + 12 del microfix); árbol idéntico al terminar |
| Verificación en navegador (backend simulado) | lote: 19 escenarios · 281 medidas de contraste · 0 desbordes — microfix: 70 comprobaciones en verde (fila de acciones en 11 anchos, 6 combinaciones de actor y plan, recorrido del dólar) |
| **E2E `@beta-ux-1f`** (23 tests) | corrió en GitHub sobre `a528eee`: 20 / 22, con 2 rojos reales (§13). Sobre el microfix: **lo valida CI** |
| **`m7-local` vecinos** | corrió en GitHub sobre `a528eee`: 351 pasaron, 8 rojos en `tab-contrast` (§13). Sobre el microfix: **lo valida CI** |

**Un test intermitente, ajeno al lote.** `orderIntakeMobile › scanner cross-browser ›
enumerateDevices vacío pero getUserMedia OK` falló en 3 de las 4 corridas completas de la suite en
el lote original y otra vez en la corrida completa del microfix; aislado pasa siempre (8/8), y en la
base (`e7298f7`) la corrida completa dio 2.918 / 2.918. Monta sólo `BarcodeScannerDialog`: no toca
nada de este lote. Depende del tiempo de carga de la máquina, y la suite nueva suma carga a la
corrida completa. CI lo corre dentro de `test:mobile2a`, con cuatro archivos, y ahí pasó.

### Controles negativos

`evidence-1f/negative-controls.mjs` rompe a propósito cada invariante, corre la suite, exige que
falle **en el test que corresponde**, restaura el archivo y compara el árbol byte a byte. Los diez
que pedía el lote, trece más (autoridad de caja, red, estados canónicos, fecha argentina, doble
lectura de la cotización) y los del microfix: el shell vuelve a repreciar, la lectura de la
cotización acoplada al reprecio, Inicio sin el reprecio heredado, un segundo pedido de cotización,
el reprecio repetido al reentrar, el timer forzando la fuente, el bloque de Tareas sin gate, con
sólo el plan, con sólo la capacidad, abierto durante la carga, con otra capacidad, y la fila de
mobile centrada. Salida en `evidence-1f/negative-controls.txt`.

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

El microfix no cambia la identidad visual y no regrabó capturas: a 375 px con estas fuentes la fila
de acciones ya salía pareja en `dashboard-owner-mobile.png`. Lo que agrega es una verificación
medida, con el mismo arnés: `evidence-1f/verify-microfix.mjs`, salida en
`evidence-1f/verify-microfix.txt` (§17).

## 16. Archivos

**Nuevos**

- `src/hooks/useOperationalDashboardStats.ts` — lo que Inicio lee de la operación.
- `src/hooks/useDollarRate.ts` — cotización compartida (shell) + reprecio heredado (lo monta Inicio).
- `src/hooks/useTasksAccess.ts` — el gate de `/tasks` para superficies fuera de la navegación.
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
- E2E: `m7/fixtures.ts` y cuatro specs (§13); `m7/tab-contrast.spec.ts` (sin la superficie de Inicio).
- `package.json` (`test:beta-ux-1f`) · `.github/workflows/ci.yml`.

## 17. Microfix sobre `a528eee`

Mismo PR (#175), misma rama. Sin migraciones, sin Edge Functions, sin `db push`, sin deploy.

### 17.1 Tareas comparte el gate de `/tasks`

**Hallazgo.** `/tasks` exige `permission="orders"` y `feature="tasks"`; el Sidebar y la navegación
móvil usan el mismo contrato. El bloque de Inicio se dibujaba sin mirar el plan: Inicio → «Nueva
tarea» / «Ver todas» → `/tasks` → pantalla de «mejorá tu plan».

**Corrección.** `Dashboard` monta `DashboardTasks` sólo si `useTasksAccess().canAccessTasks`:
capacidad `orders` + feature `tasks`, con el plan confirmado. Detalle en §7.

| Caso | Bloque | Requests a `tasks` |
|---|---|---|
| A · feature `tasks` + `orders` | visible | sí |
| B · feature `tasks` sin `orders` | ausente | 0 |
| C · `orders` sin feature `tasks` | ausente | 0 |
| D · sin ninguna | ausente | 0 |
| Plan todavía leyéndose | ausente | 0 (aparece al confirmarse, si corresponde) |
| Lectura del plan sin datos | ausente | 0 |

En los cuatro casos A–D la decisión del bloque coincide con la de los **guards reales de la ruta**
(montados en el test, compuestos como en `App.tsx`) y con `isNavigationItemAuthorized`, la función
que arma el menú.

### 17.2 El shell muestra el dólar; sólo Inicio reprecia

**Hallazgo.** 1F había movido bien la presentación de la cotización al shell, pero además montaba
`useInventoryDollarPriceSync()` en `MainLayout`: cada lectura terminada —la inicial en cualquier
pantalla, la del timer global de 15 minutos, la manual— disparaba `refreshInventoryDollarPrices`,
un `UPDATE` por producto. Navegar por la aplicación o dejarla abierta en Clientes se había vuelto un
disparador de escrituras de inventario.

**Corrección.** Se quitó de `MainLayout` y se monta desde `Dashboard`. Contrato completo en §5; la
deuda de fondo queda registrada como DOLLAR-PRICE-SYNC-1 (§11).

Medido en Chromium, con el código y el CSS reales y el backend simulado (dos productos en USD):

| Paso | Consultas a la fuente | Lecturas de productos en USD | `UPDATE inventory` |
|---|---|---|---|
| Cargar la aplicación en `/orders` | 1 | 0 | 0 |
| «Actualizar cotización» desde `/orders` | 2 | 0 | 0 |
| Navegar a `/customers` | 2 | 0 | 0 |
| Entrar a Inicio | 2 (sin pedido nuevo) | 1 | 2 |
| «Actualizar cotización» en Inicio | 3 | 2 | 4 |
| Salir a `/orders` y actualizar otra vez | 4 | 2 | 4 |
| Volver a Inicio, salir y volver a entrar | 4 | 3 | 6 |
| Carga directa en `/dashboard` (sesión nueva) | 1 | 1 | 2 |

### 17.3 La fila de acciones de mobile

Hallazgo del E2E de GitHub, no del owner (§13). Con `align-items: stretch` las tres secundarias
miden lo mismo en todo el barrido (320 → 767 px). El control en vivo —reponer la regla anterior—
reproduce la fila despareja en 390, 412, 430 y 480 px con las fuentes de esta máquina.

### 17.4 Tests

- `tests/components/betaUx1fDashboard.test.tsx`: 103 → 129. Nuevos: el gate de Tareas (A–D, cero
  requests, sin hueco, plan en carga, plan sin datos, equivalencia con la ruta y con el menú) y el
  bloque del dólar (el shell no monta la sincronización; una pantalla que no es Inicio no reprecia;
  un refresh fuera de Inicio no actualiza productos; el timer no fuerza ni reprecia; Inicio conserva
  el reprecio con una sola lectura; una vez por lectura; no se repite al reentrar; se detiene al
  salir).
- Tests que fijaban lo contrario y se dieron vuelta: «vive en el shell: `MainLayout` lo monta» y «ni
  la cotización ni el reprecio salen de esta pantalla».
- E2E `dashboard-day-one`: 22 → 23. La fila de secundarias exige el mismo alto y se mide a 375, 390
  y 430; `abrir` espera el bloque de Tareas (ahora se monta con el plan confirmado); un test nuevo
  recorre `/orders` → Inicio → `/orders` y cuenta las lecturas de `inventory?…linked_to_dolar=eq.true`
  y las escrituras de inventario. **No se pudo ejecutar en local**: lo valida GitHub.
- E2E `tab-contrast`: 26 → 18 (sin las ocho de Inicio).
