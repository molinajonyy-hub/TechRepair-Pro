# BETA-UX-2 — consistencia visual + recepción de órdenes más rápida

Rama `claude/beta-ux-2-consistency-orders` (base `main` `b144909`). Sin migraciones, sin Edge Functions,
sin cambios de Mercado Pago ni de lógica financiera. El payload de `create_order_intake` no cambió de forma:
cambió el **valor** del secreto de patrón (ver §1.5).

## 1. Discovery — lo que se encontró de verdad

Medido con `evidence/capture.mjs` (sesión falsa + Supabase simulado, nada sale de la máquina) sobre `main` y
sobre la rama, 15 pantallas × escritorio (1440) y celular (390). Tabla completa en §5.

### 1.1 Tres encabezados de página distintos

| Patrón | Pantallas | Ícono | Glifo | Subtítulo |
|---|---|---|---|---|
| `.page-hdr` a mano | Órdenes, Clientes, Inventario, Garantías, Caja, Reportes, Configuración, Usuarios… (16) | 44 px, **gradiente** índigo→violeta | 22 | 12,8 px `--text-muted` |
| `AppPageHeader` (`.page-top`) | Inicio, Tareas, Gastos, Cuentas, Nuevo cliente | 40 px plano, tinte casi invisible | 20 | 14 px `--text-subtle` (**2,6:1** en claro) |
| `.page-top` + `.stat-icon` a mano | Comprobantes, Finanzas, Auditoría, Proveedores | 36 px (Proveedores: 40 px en línea) | 20 | 14 px `--text-subtle` |

Las acciones del encabezado tampoco eran una categoría: 44 px (Órdenes), 33 px (Gastos, Cuentas, Inventario),
39 px (Proveedores, Usuarios), con `btn-lift` y gradientes sueltos.

### 1.2 Espaciado: padding doble

`.page-shell { padding: 1.5rem 2rem }` se sumaba al padding que ya pone `.main-layout-inner`. Las nueve
pantallas que lo usan quedaban **24 px más abajo** de la barra superior (48 vs 24) y **32 px más adentro**
por lado; en el celular perdían 16 px por lado (32 vs 16). Inicio ya lo había anulado sólo en mobile (1F).
Caja tenía su propio `padding: 1.5rem` y Finanzas ponía el aviso contable **antes** del título (168 px hasta
el encabezado).

### 1.3 Configuración

Diez pestañas en una fila que envolvía a dos líneas, sin agrupación, con íconos repetidos o equivocados (un
escudo para «Seguridad» y para «Cobros y Pagos», una campana para «Comisiones»). El interruptor del módulo
Mayorista vivía escondido en «Comisiones».

### 1.4 Recepción: 10 pasos

Cliente · Equipo · Identificación · Estado y fotos · Checklist · Acceso · Problema · Asignación · Presupuesto
· Resumen. Una recepción mínima eran **nueve «Continuar»**, siete sobre pasos opcionales. La barra de progreso
era un gradiente índigo→cyan sin nombres de paso (no existe en el resto del sistema).

### 1.5 «Patrón» — bloqueo real, del lado del servidor

- La grilla numera los puntos **1–9** y el wizard los mandaba así (`[1,5,9]`).
- El servidor (`private.mobile2a_legacy_from_access`, en `create_order_intake` y en
  `set_order_device_access_secret`) acepta sólo **0–8** (`^[0-8]$`), el formato del frontend anterior
  (`pattern:0-4-8`) y el de los patrones migrados a Vault. Verificado de sólo lectura que la regla está en
  producción.
- Resultado: **cualquier patrón que usara el punto 9 hacía fallar toda la creación** con el código crudo
  `INVALID_ACCESS_PATTERN` en pantalla. El E2E de MOBILE-2A dibujaba 1-5-9 pero volvía a PIN antes de crear,
  así que nunca lo vio.
- Además el cliente bloqueaba «Continuar» con patrón de menos de 2 puntos, PIN fuera de 4–12 dígitos (y
  **truncaba** en silencio un PIN de 13–16, que Android admite) o contraseña vacía.
- Producción, sólo conteos (ningún secreto leído): 13 patrones migrados del frontend viejo (base 0) y **1
  solo** patrón guardado por el wizard nuevo desde MOBILE-2A (21/09, base 1), contra 13 PIN nuevos. Que haya
  uno solo es coherente con que el punto 9 rompía la creación.

Otros campos revisados: el **IMEI** también frena, pero lo exige el servidor (`INVALID_IMEI`, dígito
verificador): es un identificador, se mantiene el bloqueo y el mensaje ahora dice cómo seguir («corregilo o
dejalo vacío»). Marca, modelo, problema y cliente los exige la RPC. El presupuesto inválido sigue frenando.

## 2. Qué se cambió

**Encabezado compartido.** `AppPageHeader` es EL encabezado y emite la familia `.page-hdr*` (la de Órdenes,
la referencia). Ícono en tinte plano con tokens (`--page-header-icon` 48/44 px, glifo 24/22, radio 14/12), sin
gradiente; tono semántico por nombre (`tone="success" | "danger" | "info"…`) en vez de colores sueltos;
subtítulo 14 px en `--text-secondary` (AA sobre el fondo del shell en los dos temas). Las pantallas que
todavía escriben el marcado a mano se ven idénticas porque comparten las mismas reglas.
Migradas al componente: Órdenes, Comprobantes, Proveedores, Finanzas, Auditoría financiera, Caja, Garantías,
Reportes y Configuración (Inicio, Tareas, Gastos, Cuentas y Nuevo cliente ya lo usaban).
Las acciones visibles de esos encabezados pasan a la categoría de acción de página (44 px): «Actualizar»
`ghost`, la principal `primary`, «Cerrar Caja» y «Nuevo Gasto» `danger` (la misma variante que «Registrar
gasto» en Inicio), sin `btn-lift` ni `btn-sm`.

**Espaciado.** `.page-shell` sin padding propio; Caja sin padding y alineada a la izquierda (centrada, su
encabezado arrancaba en otra columna en pantallas anchas); Configuración igual; Finanzas pone el título antes
del aviso. Tokens `--page-header-gap` (24 / 16 px) y `--page-block-gap` (20 / 16 px). Resultado medido: barra
→ encabezado 24 px y misma columna en las 15 pantallas de escritorio; 16 px en el celular.

**Configuración.** `SettingsNav`: cuatro grupos — Negocio (Datos, Preferencias, Seguridad) · Facturación
(Puntos de venta, Integración ARCA) · Cobros (Cobros y pagos, Comisiones y mayorista) · Documentos y mensajes
(Orden impresa, Comprobantes, WhatsApp). ≥1024 px: columna lateral fija con la sección a la derecha; la
seleccionada lleva peso 700 + barra lateral + `aria-current="page"`. <1024 px: lista agrupada estilo iOS que
abre la sección a pantalla completa con «‹ Secciones» para volver. La sección vive en la URL (`?tab=`): los
enlaces existentes (`?tab=arca`, `?tab=pagos`, `?tab=whatsapp`) siguen abriendo directo y «Atrás» del
navegador funciona. Un `?tab=` desconocido cae a «Datos» en vez de dejar la pantalla en blanco. El contenido
de cada sección no se tocó.

**Recepción en 4 pasos** (`NewOrder.tsx`) + **`AppStepper`** (nuevo, en `src/ui`) en lugar de la barra.

**Acceso que nunca bloquea** (`features/order-intake/model.ts`): el patrón viaja en el contrato del servidor
(`patternToCanonical`, 1–9 → 0–8, sólo en el borde con la RPC). Un PIN, contraseña o patrón sin valor
guardable no frena: avisa (aviso suave con ícono, `role="status"`), deja seguir y la orden se registra como
«No lo proporcionó» — es lo que pasó — y el acceso se carga después desde el detalle. 2–3 puntos o un PIN
corto se guardan igual, con una ayuda. PIN hasta 16 dígitos. Los códigos del servidor se muestran en castellano.
`DeviceLockCard` (detalle) guarda con el mismo códec y muestra lo revelado en la numeración de la grilla, con
la grilla de sólo lectura.

## 3. Qué se simplificó — recepción antes / después

| Antes (10 pasos) | Después (4 pasos) | Por qué ahí |
|---|---|---|
| 1 Cliente | **1 Cliente** | igual |
| 2 Equipo · 3 Identificación · 6 Acceso | **2 Equipo y acceso** | todo se lee del equipo que está en el mostrador |
| 7 Problema · 4 Estado y fotos · 5 Checklist | **3 Ingreso** (problema primero; checklist plegado con «N de 8 revisadas») | lo obligatorio arriba; lo largo y opcional, a un toque |
| 8 Asignación · 9 Presupuesto · 10 Resumen | **4 Confirmar** (técnico, prioridad, presupuesto + resumen con «Editar») | los tres opcionales al final, junto a la confirmación |

Recepción mínima: **9 → 3 «Continuar»**. No se quitó ningún dato. El stepper deja volver a pasos hechos (no
saltear hacia adelante: cada paso valida lo suyo) y el resumen tiene «Editar» por sección. Si al confirmar
falta algo obligatorio, se vuelve a ese paso y se enfoca el campo. En el celular las seis opciones de acceso
van a dos columnas (antes, apiladas: ~400 px) y su ayuda queda sólo para el lector de pantalla.

## 4. Decisiones que conviene revisar

1. **Familia de clases.** El componente emite `.page-hdr*` y no `.page-top*`: decenas de tests y estilos
   apuntan a `.page-hdr-right` / `.page-hdr-title`. Se actualizaron las cuatro referencias a `.page-top` /
   `.page-subtitle` (dos E2E, un test de 1F y dos reglas CSS de Inicio y Nuevo cliente).
2. **Subtítulo en `--text-secondary`.** `--text-muted` da 4,3:1 sobre el degradé claro del shell; 1F ya lo
   había resuelto así sólo para Inicio y ahora es de todas.
3. **Acceso incompleto = «No lo proporcionó».** No se puede guardar un patrón de 0–1 puntos (el servidor exige
   ≥2) y guardarlo en observaciones lo sacaría de Vault. Se dice en el aviso y en el resumen.
4. **IMEI sigue frenando** (regla del servidor). Se puede vaciar para seguir.
5. **Configuración <1024 px** es lista → sección (dos niveles, como Ajustes de iOS). Configuración salió de
   `tab-contrast.spec.ts` (ya no usa `.tab`); sus estados y contraste los mide `beta-ux-2-consistency.spec.ts`.
6. **«Comisiones» pasó a «Comisiones y mayorista»** porque esa sección tiene el interruptor del módulo.

## 5. Evidencia

Láminas «antes · main | después · BETA-UX-2» (backend simulado):

- `evidence/01-encabezados-escritorio.png`, `evidence/02-encabezados-celular.png`
- `evidence/03-configuracion.png`
- `evidence/04-recepcion-pasos.png` (10 contra 4), `evidence/05-recepcion-escritorio.png`
- `evidence/06-patron-no-bloquea.png` (`INVALID_ACCESS_PATTERN` → orden creada)

Medidas (`evidence/measures-before.json`, `evidence/measures-after.json`, tabla con
`evidence/measures-table.mjs`):

| Pantalla | Barra → encabezado | Margen izq. | Ícono | Glifo | Subtítulo | Encabezado → contenido |
|---|---|---|---|---|---|---|
| orders-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| comprobantes-desktop | 48 → **24** | 324 → **292** | 36px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| customers-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| inventory-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| tasks-desktop | 48 → **24** | 324 → **292** | 40px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| caja-desktop | 48 → **24** | 324 → **292** | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 48 |
| expenses-desktop | 48 → **24** | 324 → **292** | 40px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| suppliers-desktop | 48 → **24** | 324 → **292** | 40px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| cuentas-desktop | 48 → **24** | 324 → **292** | 40px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| warranties-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| reports-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| finance-desktop | 168 → **24** | 324 → **292** | 36px → **48px** | 20 → **24** | 14px #94a3b8 → **14px #334155** | 24 |
| settings-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| users-desktop | 24 | 292 | 44px grad. → **48px** | 22 → **24** | 12.8px #64748b → **14px #334155** | 28 → **24** |
| dashboard-desktop | 48 → **24** | 324 → **292** | 40px → **48px** | 20 → **24** | 14px #334155 | 24 |
| dashboard-mobile | 70 | 16 | 40px → **44px** | 20 → **22** | 12.8px #334155 → **13px #334155** | 24 → **16** |
| orders-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 16 |
| comprobantes-mobile | 32 → **16** | 32 → **16** | 36px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| customers-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 16 |
| inventory-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 28 → **16** |
| tasks-mobile | 32 → **16** | 32 → **16** | 40px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| caja-mobile | 40 → **16** | 40 → **16** | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 48 |
| expenses-mobile | 32 → **16** | 32 → **16** | 40px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| suppliers-mobile | 32 → **16** | 32 → **16** | 40px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| cuentas-mobile | 32 → **16** | 32 → **16** | 40px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| warranties-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 28 → **16** |
| reports-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 28 → **16** |
| finance-mobile | 254 → **16** | 32 → **16** | 36px → **44px** | 20 → **22** | 12.8px #94a3b8 → **13px #334155** | 24 → **16** |
| settings-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 28 → **16** |
| users-mobile | 16 | 16 | 44px grad. → **44px** | 22 | 12.8px #64748b → **13px #334155** | 28 → **16** |

Recepción (390 px): 10 pasos → **4**; secreto del patrón 1-5-9: `[1,5,9]` (`INVALID_ACCESS_PATTERN`) →
**`[0,4,8]`** (orden creada). Caja conserva 48 px hasta el contenido por la tarjeta «Abrir Caja», que tiene su
propio `margin: 3rem auto` (estado sin caja abierta; no se tocó).

Reproducir:

```bash
node docs/beta-ux-2/evidence/capture.mjs . <salida> after
node docs/beta-ux-2/evidence/contact-sheet.mjs . <dirAntes> <dirDespues> <salida>
node node_modules/@playwright/test/cli.js test --config docs/beta-ux-2/evidence/e2e-mock/playwright.config.ts
```

El último corre los specs REALES `m7/beta-ux-2-consistency`, `m7/mobile2a-order-intake` y
`m7/ordersV20Desktop` contra un Supabase simulado (`e2e-mock/serve.mjs`, que replica las reglas de acceso de
`create_order_intake`). No reemplaza al job `e2e-local` de CI; reescribe capturas versionadas de lotes
anteriores (revertirlas con `git checkout -- docs/p0-mobile-evidence docs/orders-v2-0-evidence`).

## 6. Pendiente / fuera de alcance

- **Un patrón guardado en base 1 (21/09/2026, una orden).** Con el códec corregido se va a revelar corrido un
  punto. Opciones: volver a cargarlo desde «Acceso del equipo → Configurar» de esa orden, o una corrección de
  datos server-side identificando la orden por su auditoría (`stored` + `pattern` posterior a MOBILE-2A). Es
  Vault: decisión del owner, en otra tarea. No se tocaron datos.
- Migrar al componente el marcado de los encabezados que siguen escritos a mano (Clientes, Inventario,
  Mayorista, Ofertas, Usuarios, Suscripción, Moneda, Ayuda, Leads, Detalle de cliente). Ya se ven iguales por
  CSS; es refactor de marcado sin cambio visual.
- Acciones de encabezado fuera de las pantallas migradas (Inventario 33 px, Usuarios 39 px): BUTTON-SYSTEM-1B.
- Los paneles internos de Configuración conservan sus estilos (algunos colores fijos de tema oscuro).
- `tests/e2e/webkit/intake-mobile.spec.ts` se adaptó a los 4 pasos pero no corre en CI ni se ejecutó acá.
