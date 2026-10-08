# BETA-UX-1D — La orden en el celular

Cierra **P1-1**, **P1-5** (Órdenes y Clientes) y **P2-2** (parcial: encabezado de Clientes) del
discovery BETA-UX-1 (`beta-ux-1-discovery.md`, §C).

Base: `main` `6f47faa544cbb8f7bf17a55688b05b90a9a20fba` (merge certificado de BETA-UX-1C, #172).

Sólo presentación. **Sin migraciones, sin cambios en Edge Functions, sin `db push`, sin deploy, sin
tocar producción.** No cambia RLS, permisos, la autoridad financiera, ninguna consulta ni ninguna
regla de negocio. No toca el POS, Inventario, Proveedores ni Usuarios.

---

## 1. Problema

Medido sobre la base, a 375 px, antes de tocar nada (sonda de §9):

| | Qué pasaba | Dónde |
|---|---|---|
| **P1-1** | El detalle de orden era una grilla fija de dos columnas: **159,5 px + 159,5 px**. Cliente y Dispositivo quedaban a 160 px cada uno, «Acceso del equipo» a media pantalla y Marca / Modelo en dos columnas de ~60 px | `OrderDetail.tsx:334`: `gridTemplateColumns: '1fr 1fr'` en línea. Una media query no puede pisar un estilo en línea |
| | El encabezado mostraba **cinco acciones de 33 px**: Volver, Ver Comprobante, Imprimir, WhatsApp y Garantía | `btn-sm` sin alto táctil |
| **P1-5** | Órdenes era una tabla de **1.176 px** dentro de una pantalla de 375; Clientes, de **837 px**. Para operar una orden había que scrollear a lo ancho | `Orders.tsx`, `Customers.tsx`: `<table>` de 9 y 5 columnas en cualquier ancho |
| | El estado vacío vivía en un `<td colSpan>`: heredaba el ancho de la tabla y en mobile quedaba recortado | idem |
| | Filtrar por **cobro** sin coincidencias decía «Todavía no tenés órdenes», y «Limpiar filtros» del estado vacío no limpiaba ese filtro | `Orders.tsx:298`/`303`: la rama miraba búsqueda, estado y prioridad, no `paymentFilter` |
| | Clientes sin datos no ofrecía ninguna acción | `Customers.tsx:451`: `EmptyState` sin `action` |
| **P2-2** | El encabezado de Clientes tenía **cuatro botones de 33 px**, con las tres secundarias antes de la primaria | `Customers.tsx:399-404` |

## 2. Corte y alcance

| Ancho | Detalle de orden | Órdenes / Clientes |
|---|---|---|
| **< 768 px** | una columna; una primaria + menú | tarjetas (`CompactList`); una primaria + menú |
| **≥ 768 px** | dos columnas; acciones a la vista | la tabla de siempre |

- El corte es el del producto: **768 px**. Todo el bloque usa consultas `max-width` (767, 480 y 359);
  ninguna regla de escritorio depende de un `min-width`, así que ≥ 768 es el caso base.
- **Responsive por CSS**, no por JS: no hay `innerWidth`, `matchMedia` ni un estado de viewport en
  ninguna de las tres páginas. Una rotación no re-renderiza nada.
- Ajustes más finos: a ≤ 480 px Marca y Modelo se apilan; a < 360 px los filtros pasan a una columna.
- Entre 768 y 1023 px el shell sigue siendo el de mobile (barra inferior) con la tabla adentro, igual
  que antes: ese corte es de MOBILE-1 y no se tocó.

CSS: bloque `BETA-UX-1D` de `src/index.css`, sólo tokens de tema. Va **antes** del bloque de 1C a
propósito: los tests de 1C recortan «desde su título hasta `@media print`».

### Costo de montar las dos presentaciones

Elegir por CSS implica que la tabla y las tarjetas están las dos en el DOM y una queda en
`display: none`. Órdenes trae 50 como máximo; Clientes no pagina, así que se midió ahí, con 358
clientes, a 375 px y con la CPU frenada ×4 (`evidence-1d/dual-tree-cost.json`):

| Clientes · 358 filas | Base | Rama |
|---|---|---|
| Nodos del DOM | 12.600 | 19.430 (+54 %) |
| Carga — tareas largas del hilo principal | 6,9 s | 7,3 s (+6 %) |
| Escribir una letra en el buscador y borrarla — tareas largas | 10,4 s | 2,1 s (−80 %) |

Hay más nodos, pero lo que el teléfono tiene que maquetar es más barato: la tabla oculta no se
maqueta y las tarjetas cuestan menos que una tabla de 837 px. Son medidas de una sola máquina
(mediana de 5 vueltas, Chromium): sirven para comparar base contra rama, no como números absolutos.

## 3. Detalle de orden

### Grilla

- La grilla principal pasó de un estilo en línea a `.order-detail-grid`: `repeat(2, minmax(0, 1fr))`
  y, por debajo de 768, `minmax(0, 1fr)`.
- Los bloques que tenían `gridColumn: 'span 2'` usan `.order-detail-grid__full`
  (`grid-column: 1 / -1`), que vale igual con una columna que con dos: Comprobante, Ítems, Estado
  financiero, Notas, Documentos, Comunicación e Historial.
- Mismo orden semántico en los dos modos: Cliente → Dispositivo → Acceso del equipo → Comprobante →
  Ítems → Estado financiero. No se oculta nada.
- Marca / Modelo: `.order-device-grid`, dos columnas que se apilan a ≤ 480 px.
- Textos largos: `overflow-wrap: anywhere` en las tarjetas de Cliente y Dispositivo (con
  `word-break: break-word` de respaldo para WebKit anterior a iOS 15.4). Un modelo como «Galaxy S24
  Ultra 5G 512GB Titanium Black» envuelve; uno sin espacios se parte en vez de ensanchar la tarjeta.
- `minmax(0, 1fr)` en lugar de `1fr` es el único ajuste estructural de escritorio: con `1fr` una
  palabra larga podía ensanchar la columna. Con los datos de prueba la geometría es idéntica (§9).

### Encabezado: acciones visibles vs. menú

| | < 768 px | ≥ 768 px |
|---|---|---|
| **Volver a Órdenes** | visible, 44 px | visible, como antes |
| **Generar Comprobante** (sin comprobante y facturable) | **visible** — primaria, 44 px, de lado a lado | visible, como antes |
| **Ver Comprobante** (ya existe) | **visible** — primaria, 44 px, de lado a lado | visible, como antes |
| Imprimir | menú «Más acciones» | visible, como antes |
| WhatsApp (4 plantillas) | menú «Más acciones» | desplegable de siempre |
| Garantía | menú «Más acciones» | visible, como antes |

- La primaria es **un solo elemento** para los dos anchos (`data-testid="order-primary-action"`): el
  CSS le da el ancho y el alto táctil. No se duplicó.
- Cuando la orden no se puede facturar de verdad (sin importes autorizados, SEC-08A) no hay primaria:
  queda el menú, a la derecha.
- Las secundarias de escritorio viven en un contenedor con `display: contents` (son hijas directas de
  la fila, como antes) que mobile oculta; el menú vive en otro que escritorio oculta.
- **WhatsApp — opción B**: el menú lleva las cuatro plantillas directamente («WhatsApp: Orden
  recibida», «…Presupuesto listo», «…Equipo listo para retirar», «…Mensaje libre»). Se eligió sobre
  «un ítem que abre el selector» porque el selector existente es un desplegable que se cierra con
  `onMouseLeave` y tiene opciones de ~30 px: no es apto para tocar, y hacerlo apto era construir una
  segunda superficie. Con B cada plantilla es un `menuitem` de 44 px, a dos toques, con el foco y el
  Escape que ya resuelve `OverflowMenu`. No se duplicó lógica: las plantillas son una sola constante
  (`WHATSAPP_TEMPLATE_OPTIONS`) y las dos presentaciones llaman a `openWhatsApp(templateKey)`.
- Imprimir y Garantía llaman a los mismos `setShowPrintModal` / `setShowWarrantyModal`.

### Lo que no se tocó

- **Cambio de estado** (`StatusChange`): cumple a 320 px (selector de 48 px, botón de 46 px, sin
  desborde). Sin cambios.
- **Pestañas**: siguen con scroll horizontal; miden 44 px en mobile.
- Colores fijos de la página: son de BETA-UX-1E.

### Ajustes mínimos dentro del detalle (sólo layout)

- Toda acción (`.btn`) del encabezado y de las tarjetas mide ≥ 44 px por debajo de 768.
- Los encabezados de tarjeta envuelven si título y acción no entran: a 320 px «Ítems de la orden»
  quedaba pisado por «Agregar ítem».
- `NotificationCard` (pestaña Comunicación): la fila «email + Se recomienda notificar» envuelve. A
  ≤ 375 px el aviso quedaba recortado por la tarjeta (54 px a 320).

## 4. Órdenes: de la tabla a la tarjeta

| Columna de la tabla | En la tarjeta | Slot de `CompactList` |
|---|---|---|
| Cliente | nombre | `primary` |
| Orden | `#id` corto, al lado del nombre | `primary` |
| Dispositivo | «Marca Modelo» o «Sin dispositivo» | `secondary` |
| Fecha | fecha | `metadata` |
| Prioridad | «Prioridad urgente / alta», **sólo** para esas dos | `metadata` |
| Estado | mismo badge técnico | `status` |
| Cobro | mismo `OrderFinancialBadge`, mismas props | `status` |
| Total | total; debajo «Saldo $…» si hay saldo pendiente | `amount` |
| Acciones | la tarjeta entera abre el detalle; menú con **Imprimir** y **Eliminar** | `onSelect` / `trailingAction` |

- «Ver detalle» y «Editar» de la tabla navegan al mismo detalle: en mobile lo resuelve la tarjeta. Las
  cuatro acciones de escritorio no se tocaron.
- Eliminar usa la confirmación de siempre (una sola). Imprimir usa el mismo `handlePrint`. Por debajo
  de 768 px los dos botones de esa confirmación miden 44 px (son `btn-sm`, que mide 33; en Clientes
  son `btn`, que mide 39).
- Composición: `CompactList` reparte `[textos | importe + estado]` en una fila, que a 375 px le deja
  ~140 px al nombre y al equipo. En las dos listas los textos usan todo el ancho y la última fila
  lleva lo que se compara entre tarjetas (estados a la izquierda, importe a la derecha); el menú va
  fijo arriba a la derecha. Es CSS con alcance a `.orders-mobile-list` / `.customers-mobile-list`: el
  primitivo no cambió de layout para nadie más.
- Filtros (ajuste acotado): búsqueda de lado a lado y los tres filtros de a dos (el que queda solo
  ocupa la fila). El texto de un filtro que no entra se corta con elipsis. Se conservan búsqueda,
  estado, cobro, prioridad, «Limpiar filtros» y el contador.
- «Nueva Orden»: 44 px, de lado a lado.

## 5. Clientes: de la tabla a la tarjeta

| Columna de la tabla | En la tarjeta | Slot |
|---|---|---|
| Cliente | nombre + badge **MAYORISTA** | `primary` |
| Contacto | teléfono y/o email (o «Sin datos de contacto») | `secondary` |
| Órdenes | «2 órdenes» / «1 orden» | `metadata` |
| Total | total del cliente | `amount` |
| Acciones | la tarjeta abre la ficha; menú con **Editar** y **Eliminar** | `onSelect` / `trailingAction` |

- Editar llama a `openEdit(customer)`: el mismo `ResponsiveDialog` de siempre. Eliminar, la misma
  confirmación.
- **Encabezado (P2-2)**: por debajo de 768 px queda **Nuevo Cliente** (44 px, de lado a lado) y un
  menú con **Plantilla**, **Exportar** e **Importar**, que llaman a los mismos handlers. Desde 768 px,
  las cuatro como antes.

## 6. Autoridad de importes

Mobile es otra presentación de datos que ya estaban en pantalla. No hay consultas nuevas.

- **Órdenes**: tabla y tarjetas leen los importes de **una** función, `orderAmounts(orderId)`, que
  devuelve `null` si `financialError || amountsAuthorized !== true`. Es la regla que ya tenía la celda
  «Total», movida a un lugar para que las dos presentaciones no puedan divergir. El total sigue
  siendo `labor_cost || estimated_total` del mapa `financial` (de `get_order_financial_amounts`) y el
  saldo, `saldo_pendiente` de la misma fila. No se suma nada: ni líneas, ni pagos.
- El estado de cobro sale del mismo mapa (`v_order_payment_state`), con el mismo badge.
- Estados de la tarjeta:

  | `amountsAuthorized` | En la tarjeta |
  |---|---|
  | `true` | total, y saldo si es > 0 |
  | `false` | «Importes restringidos» (texto) |
  | `null` o bloque financiero caído | «—» con «Importe no disponible» para lectores de pantalla |

- **Clientes**: el total es `formatCurrency(stats.total)` del mismo `customerStats`, detrás del mismo
  `amountsAuthorized`. Sin autorización: «—» con «Importe restringido».
- Imprimir desde el menú usa el `handlePrint` existente, que ya gatea el presupuesto por la
  autorización.

**Prueba con un actor real.** El E2E crea un empleado propio (usuario de Auth + perfil `sales` con
`orders_view_financials: false`) y entra por la pantalla de login. No se degrada al owner: la
autoridad de importes es `current_user_can_in_business`, que le reconoce autoridad de dueño al
`businesses.owner_user_id` sin mirar su perfil, así que cambiarle el rol al usuario E2E no le saca los
importes. Con ese empleado:

- el servidor responde `{ ok: true, authorized: false, rows: [] }` a `get_order_financial_amounts`,
  cero filas en `v_order_payment_state` y un error al leer `estimated_total` de la tabla;
- en Órdenes (375 y 320 px) cada tarjeta dice «Importes restringidos», el estado de cobro es «No
  disponible», y en toda la lista —incluida la tabla que el CSS oculta— no hay un `$` ni un número
  con forma de importe;
- en Clientes no hay total; el conteo de órdenes sigue;
- en el detalle no hay acción de facturar y no hay importes.

Control positivo: el dueño recibe `authorized: true` por la misma ruta y la tarjeta muestra
exactamente esos valores.

## 7. Estados vacíos

Si la colección filtrada está vacía **no se monta ni la tabla ni la lista**: el `EmptyState` va en su
propio contenedor (`orders-empty-state` / `customers-empty-state`, con `data-empty-kind`).

| Pantalla | Caso | Título | Acción |
|---|---|---|---|
| Órdenes | sin datos | «Todavía no tenés órdenes» | **Nueva Orden** → `/orders/new` |
| Órdenes | filtros sin resultados | «Sin resultados» | **Limpiar filtros** — búsqueda, estado, **cobro** y prioridad |
| Clientes | sin datos | «Todavía no tenés clientes» | **Nuevo Cliente** → `/customers/new` (antes no había) |
| Clientes | búsqueda sin resultados | «Sin resultados para "…"» | **Limpiar búsqueda** |

- «Sin resultados» en Órdenes ahora cuenta el filtro de cobro como filtro. `clearFilters` es una sola
  función para el botón de la barra y el del estado vacío.
- Las acciones del estado vacío miden ≥ 44 px por debajo de 768.

## 8. Primitivos compartidos

Se reutilizaron `CompactList` y `OverflowMenu` desde `../ui`, sin clonar. Tres agregados aditivos:

- `CompactListItem.testId` → `data-testid` del `<li>`;
- `OverflowMenuProps.testId` → `data-testid` del disparador;
- `.overflow-menu__action svg { flex-shrink: 0 }`: una etiqueta que envolvía en dos líneas achicaba
  su ícono.

Y **un cambio de comportamiento** en `OverflowMenu`: al abrirse se trae a la vista
(`scrollIntoView({ block: 'nearest' })`, con `scroll-margin-bottom` igual al alto de la barra
inferior). Sin eso, en una tarjeta cercana al borde inferior «Eliminar» quedaba detrás de la barra de
navegación y había que scrollear con el menú abierto. Si el menú ya entra, no mueve nada. Lo recibe
también Tareas, que es el otro consumidor del menú.

Selectores nuevos: `order-detail-page`, `order-detail-grid`, `order-primary-action`,
`order-mobile-actions-menu`, `order-customer-card`, `order-device-card`, `order-device-model`,
`order-comprobante-card`, `order-items-block`, `order-financial-block`; `orders-desktop-table`,
`orders-mobile-list`, `orders-mobile-item`, `orders-mobile-actions`, `orders-mobile-total`,
`orders-mobile-balance`, `orders-mobile-amounts-restricted`, `orders-mobile-amounts-unavailable`,
`orders-empty-state`, `orders-filter-bar`, `orders-status-filter`, `orders-priority-filter`,
`orders-clear-filters`; `customers-desktop-table`, `customers-mobile-list`, `customers-mobile-item`,
`customers-mobile-actions`, `customers-mobile-total`, `customers-mobile-total-restricted`,
`customers-mobile-header-menu`, `customers-empty-state`, `customers-filter-bar`. No se renombró
ninguno existente.

`order-primary-action` reemplaza al `order-mobile-primary-action` sugerido: el elemento es el mismo en
los dos anchos.

## 9. Escritorio no cambia

Además de las regresiones del E2E, se sirvieron los dos builds —la base `6f47faa` y la rama— contra el
mismo backend local y los mismos datos, y se comparó la geometría de lo que escritorio ya mostraba:
encabezado, filtros, tabla (cada celda y cada control), y en el detalle la grilla, sus tarjetas, sus
textos y sus botones.

| | |
|---|---|
| Pantallas | 16 — Órdenes, Clientes y dos detalles (con y sin comprobante) × 768, 1024, 1280 y 1440 px |
| Elementos comparados | 940 (posición, tamaño y texto) |
| Tolerancia | 0,6 px |
| **Diferencias** | **0** |

Columnas de la grilla del detalle, base → rama: `352px 352px` → `352px 352px` (768),
`338px 338px` → `338px 338px` (1024), `466px 466px` → `466px 466px` (1280),
`546px 546px` → `546px 546px` (1440).

## 10. Tests

### Componentes y contrato (`npm run test:beta-ux-1d`, job `quality`)

jsdom no aplica `index.css`: ahí la tabla y las tarjetas conviven. Se mide lo que no depende del CSS.

| Archivo | Qué fija |
|---|---|
| `betaUx1dOrdersList.test.tsx` | tarjetas del mismo dataset y del mismo mapa financiero que la tabla; contenido de la tarjeta; tocar abre el detalle (click y Enter); menú Imprimir / Eliminar con la impresión y la confirmación de siempre; **sin autorización no hay un solo monto, ni con un mapa que traiga números**; autorización desconocida y bloque caído; estado vacío fuera de la tabla; filtro de cobro; «Limpiar filtros» limpia los cuatro |
| `betaUx1dCustomersList.test.tsx` | tarjetas del mismo `customerStats`; mayorista; total sólo con autorización (y sin él si el pedido falla); tocar abre la ficha; Editar abre el mismo diálogo y Eliminar la misma confirmación, filtrando por negocio; las tres secundarias en escritorio y en el menú, con el mismo handler; estado vacío con «Nuevo Cliente» y «Limpiar búsqueda» |
| `betaUx1dOrderDetail.test.tsx` | cuál es la primaria según el estado (y que no exista sin importes); el menú lleva Imprimir, las cuatro plantillas y Garantía, y cada una abre lo mismo que su botón de escritorio; Escape y foco; la grilla y los bloques de ancho completo viven en clases |
| `betaUx1dResponsiveContract.test.ts` | el bloque de CSS: < 768 tarjetas / una columna, ≥ 768 tabla / dos columnas, sólo `max-width`, sólo tokens definidos en claro y en oscuro; la fuente: sin `innerWidth` / `matchMedia`, sin grilla ni `span 2` en línea, sin estado vacío en una celda, primitivos importados desde `../ui`, una única lectura de importes gateada |

Corre además con las suites vecinas que montan estas pantallas: `mobileFoundations`,
`orderDetailHistory`, `customerSurfaces` y `customerEdit`.

`customerSurfaces.test.tsx` cambió en un punto: cinco esperas `findByText(nombre)` ahora se acotan a
la tabla de escritorio (`tableLoaded`). El nombre del cliente aparece en las dos presentaciones y esos
tests son de la tabla; ninguna aserción cambió.

### Navegador (`npx playwright test --project=m7-local --grep @beta-ux-1d`, job `e2e-local`)

`tests/e2e/m7/mobile-orders.spec.ts`, con datos propios (`seedMobileOrdersFixture.ts`) y un empleado
real. Mide, sobre el CSS servido:

- **Detalle** — 375×812 en claro y en oscuro: sin desborde y sin contenido recortado por su tarjeta;
  grilla de una columna; Cliente a todo el ancho y Dispositivo debajo; el modelo largo envuelve y el
  modelo sin espacios se parte; Acceso del equipo, Comprobante, Ítems y Estado financiero a todo el
  ancho y en el mismo orden; primaria ≥ 44 px; secundarias ocultas y un disparador de 44×44; abrir y
  cerrar con click, con Escape (foco al disparador) y tocando afuera; Imprimir abre la vista previa,
  WhatsApp abre el preview con la plantilla resuelta, Garantía abre el alta. 320×700: lo mismo, más
  cambio de estado táctil. Las otras cuatro pestañas, sin desborde.
- **Órdenes y Clientes** — 375×812 en claro y en oscuro: tabla oculta, lista visible, cada tarjeta
  completa; contenido, estados e importes de cada tarjeta del fixture; menú de 44×44 que no pisa el
  nombre; tocar abre el detalle / la ficha (también con teclado); Imprimir escribe el documento de la
  orden; Eliminar y Editar abren los flujos de siempre y cancelar no borra (se verifica en base);
  encabezado con una primaria y el menú; filtros de a dos. 320×700 sin desborde.
- **Estados vacíos** — sin datos y sin resultados, en las dos pantallas: no existe ninguna tabla, la
  acción queda al alcance a 375 px y hace lo que dice.
- **Importes restringidos** — el empleado de §6, con la comprobación contra el servidor.
- **Escritorio** — 1024 y 1440: dos columnas, acciones a la vista en una fila, tabla con sus columnas
  y sus cuatro acciones, los cuatro botones del encabezado de Clientes. Y el corte: 767 vs. 768 en las
  tres pantallas.
- **Claro / oscuro** — contraste AA de los textos principales de las tarjetas y de cada ítem de menú.

Desborde: `#root` recorta lo que se le sale (`overflow-x: hidden`), así que no alcanza con
`documentElement.scrollWidth`. Se mide además el contenedor que recorta, cada elemento que termine
fuera del viewport y —aparte— lo que una tarjeta con `overflow: hidden` esté recortando.

### Controles negativos

Se rompió el código a propósito, un defecto por vez, y se corrieron los gates. Cada mutación se
restauró y el árbol quedó idéntico (hashes).

Línea de base, sin mutar: componentes y navegador en verde.

| # | Defecto reintroducido | Componentes / contrato | Navegador |
|---|---|---|---|
| 1 | `grid-template-columns: 1fr 1fr` en mobile | rojo (1) | rojo (3) |
| 2 | la tabla vuelve a mostrarse a 375 | rojo (1) | rojo (6) |
| 3 | la `CompactList` queda oculta | rojo (2) | rojo (12) |
| 4 | Órdenes muestra un importe restringido (`orderAmounts` deja de mirar la autorización) | rojo (4) | rojo (2) |
| 4b | Clientes muestra un total restringido | rojo (3) | rojo (1) |
| 5 | el `EmptyState` vuelve adentro de una tabla | rojo (3) | rojo (3) |
| 6 | Plantilla / Exportar / Importar salen del menú sin reemplazo | rojo (2) | rojo (3) |
| 7 | el disparador del menú mide 36 px | verde (jsdom no mide) | rojo (8) |
| 8 | *(extra)* la hilera de botones del detalle sigue visible en mobile | rojo (1) | rojo (10) |
| 9 | *(extra)* la primaria del detalle vuelve a 33 px | rojo (1) | rojo (3) |
| 10 | *(extra)* el menú deja de traerse a la vista y queda debajo de la barra inferior | rojo (2) | rojo (1) |

Entre paréntesis, la cantidad de tests que fallaron. Las once mutaciones fueron detectadas; la 7 sólo
puede verla el navegador, que es donde vive esa medida.

### Resultados medidos (local, 2026-10-08, base `main` `6f47faa`)

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint src --quiet` | 0 errores |
| `npm run test:beta-ux-1d` | 8 archivos · **130 / 130** (80 son los cuatro archivos de 1D: 20 + 13 + 20 + 27) |
| Suite de componentes completa | 132 archivos · **2.830 / 2.830** en dos de tres corridas. En la otra falló por timeout `orderIntakeMobile › … el scanner ABRE igual` (escáner de la recepción; este lote no toca ese módulo): aislado pasa 8 / 8, y es un test que ya se sabía sensible a la carga de la máquina |
| `node --test tests/unit` | **1.215 / 1.215** |
| Guards | `sec08a` (+ self-test, 18 mutaciones), `sec08a-phase-b` (+ self-test, 22), `sec08a-phase-c`, `order-payment-status`, `finance-writes`, `customer-core`, `mobile2a`, `onboarding-canonical`, `ui-governance`, `no-real-data` (+ self-test, 28 / 28): todos en verde |
| `vite build` (variables de CI) | correcto |
| E2E `@beta-ux-1d` — Chromium, `m7-local` | **41 / 41**; también con 358 clientes en la base |
| El mismo spec en **WebKit real** (motor de Safari / iOS) | **38 / 38**. Quedaron afuera los 3 tests del corte 767 ↔ 768, que redimensionan el viewport a mitad del test: en WebKit sobre Windows la primera corrida se colgó en el primero de ellos. El corte queda medido en Chromium |
| E2E `m7-local` completo | **288 / 288** (12,0 min) sobre un stack local aislado con las 285 migraciones. Después de esa corrida sólo cambiaron dos declaraciones de CSS (`word-break` de respaldo) y archivos de test; tras ellas se volvieron a correr el spec de 1D y la sonda de escritorio |
| Specs legacy vecinos (proyecto `chromium`, que CI no corre) | 10 specs, 63 tests, corridos sobre la base y sobre la rama: **idénticos test por test** (22 pasan, 22 fallan y 19 se saltean en las dos) |
| Controles negativos | **11 / 11** detectados |
| Paridad de escritorio (§9) | **0 diferencias** en 940 elementos |

Dos tests ya existentes necesitaron acotar una búsqueda a la presentación visible, porque el nombre del
cliente ahora está en la tabla y en la tarjeta: `customerSurfaces.test.tsx` (ver arriba) y el spec
legacy `tests/e2e/customer-inventory.spec.ts` (un `text=` → `text=` + `visible=true`). Ninguna
aserción cambió.

## 11. Evidencia

`docs/beta-ux-1/evidence-1d/`, generada por el spec con `BETA_UX_1D_EVIDENCE=1` (las del «antes», por
la sonda de §9 sobre la base).

| Captura | Qué muestra |
|---|---|
| `antes-order-detail-375.png` | la base: dos columnas de 160 px y cinco acciones de 33 px |
| `order-detail-375-light.png` · `order-detail-375-dark.png` | el detalle en una columna |
| `order-detail-menu-375-light.png` | «Más acciones» abierto: Imprimir, las cuatro plantillas y Garantía |
| `order-detail-1440-light.png` | el detalle en escritorio, sin cambios |
| `antes-orders-list-375.png` | la base: la tabla de 1.176 px recortada |
| `orders-list-375-light.png` · `orders-list-375-dark.png` | Órdenes en tarjetas |
| `orders-card-menu-375-light.png` | el menú de una tarjeta |
| `orders-list-375-restricted.png` | Órdenes para el empleado sin importes |
| `orders-empty-375.png` | estado vacío de Órdenes, fuera de la tabla |
| `orders-desktop-1440.png` | la tabla de escritorio, sin cambios |
| `antes-customers-list-375.png` | la base: cuatro botones de 33 px y la tabla de 837 px |
| `customers-list-375-light.png` · `customers-list-375-dark.png` | Clientes en tarjetas |
| `customers-header-menu-375-light.png` | el menú del encabezado: Plantilla, Exportar, Importar |
| `customers-list-375-restricted.png` | Clientes para el empleado sin importes |
| `customers-empty-375.png` | estado vacío de Clientes, con «Nuevo Cliente» |
| `desktop-parity.json` | resultado de la sonda de §9 |
| `dual-tree-cost.json` | medidas de §2 (costo de las dos presentaciones) |

En las capturas de página completa la barra inferior aparece cruzando el contenido: es fija y la
captura la toma en su posición del primer viewport.

Las capturas acompañan a los asserts geométricos; no los reemplazan.

## 12. Smoke manual sugerido (Preview, en un teléfono)

1. Órdenes: se ven tarjetas; tocar una abre el detalle; «⋯» → Imprimir y Eliminar (cancelar).
2. Detalle: una columna; «Generar / Ver Comprobante» grande; «⋯» → Imprimir, una plantilla de
   WhatsApp y Garantía.
3. Clientes: tarjetas; «Nuevo Cliente» + «⋯» con Plantilla / Exportar / Importar; «⋯» de una tarjeta →
   Editar.
4. Buscar algo que no exista en las dos listas: estado vacío con su acción.
5. Con un usuario sin «Ver precios en órdenes»: ningún importe en Órdenes ni en Clientes.
6. En una computadora: las tres pantallas como estaban.

## 13. Fuera de alcance — hallazgos

No se tocaron. Los dos primeros conviene mirarlos antes de la beta.

1. **P1 · Imprimir desde la lista una orden sin dispositivo (o sin cliente) tumba la aplicación.**
   `ServiceOrderPrint.tsx:348` y `:356` (y `:485` / `:493`) leen `order.customer.name` y
   `order.device.brand` sin guarda, y la lista sí contempla órdenes con `customer: null` o
   `device: null`. Reproducido **en la base `6f47faa`** con el botón de imprimir de la tabla de
   escritorio: pantalla «Algo salió mal» (`desktop-parity.json`, `imprimirSinDispositivo`). El menú
   de la tarjeta llama al mismo `handlePrint`, así que lo hereda tal cual.
2. **P1 · El filtro «Listo» de Órdenes nunca devuelve nada.** La opción manda `ready` y el estado se
   llama `ready_delivery`. Tampoco se pueden filtrar `waiting_approval`, `waiting_parts` ni
   `waiting_payment` (`Orders.tsx`, opciones del filtro de estado).
3. **P2 · Clientes queda en error ante una falla transitoria al montar.** `customersService.getAll()`
   empieza por `supabase.auth.getUser()` (`api.ts:101-109`); si esa llamada falla, la pantalla dice
   «No hay una sesión activa para operar con clientes» y no reintenta sola. Visto una vez en ~60
   cargas en local, con la sesión válida y sin errores en el servidor de Auth. El spec lo reintenta
   una vez y lo anota (`carga-reintentada`).
4. **P2 · Estado vacío falso durante la carga inicial.** Órdenes no usa el `loading` de `useOrders` y
   Clientes no tiene estado de carga: hasta que llega la primera respuesta se ve «Todavía no tenés
   órdenes / clientes» con su botón. Ya pasaba dentro de la tabla.
5. **P2 · «Acceso del equipo» pierde texto según el tema** (`DeviceLockCard`). En claro la etiqueta
   «Cifrado · interno» es blanco sobre blanco (medido: 1,00:1); en oscuro «PIN configurado» y el
   ícono casi no se distinguen (captura `order-detail-375-dark`). Es de BETA-UX-1E.
6. **P2 · Controles secundarios por debajo de 44 px dentro de las tarjetas del detalle:** borrar un
   ítem (23 px) y refrescar el historial de WhatsApp (26 px). La tabla interna de ítems sigue con su
   scroll horizontal propio.
7. **P2 · Los importes tienen cuatro formatos en el mismo flujo:** `$185.000` en Órdenes,
   `$ 185.000` en Clientes, `$185000.00` en la tarjeta Comprobante del detalle y, en los ítems,
   `toLocaleString()` sin locale (el separador depende del idioma del navegador).
8. **P3 · Entre 768 y 1023 px la tabla de Órdenes sigue necesitando scroll lateral** (9 columnas con
   el shell de mobile). Era así y el corte pedido para este lote es 768.
9. **P3 · Órdenes trae como máximo 50 órdenes y no pagina;** la búsqueda filtra esas 50.
10. **P3 · Detalle de orden:** el título mide 30 px fijos en línea (no sigue el `clamp` de mobile);
    `DeviceLockCard` trae un `margin-top` propio y queda con 32 px arriba en vez de 16; el
    desplegable de WhatsApp de escritorio se cierra con `onMouseLeave`.
11. **P3 · «Exportar» de Clientes avisa con `alert()`.**
