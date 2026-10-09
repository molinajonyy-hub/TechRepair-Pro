# BETA-UX-1E — CTAs legibles fuera del embudo

Cierra **P1-6** del discovery BETA-UX-1 (`beta-ux-1-discovery.md`, §C) y el hallazgo 5 de
BETA-UX-1D («Acceso del equipo» pierde texto según el tema).

Base: `main` `2e1d0e5c9f48d2686b0906fd1feeada81523fb86` (merge certificado de BETA-UX-1D, #173).

Sólo presentación. **Sin migraciones, sin cambios en Edge Functions, sin `db push`, sin deploy, sin
tocar producción.** No cambia ninguna consulta, permiso ni regla de negocio. No se tocó la regla
global de tema claro, ni `--text-on-accent`, ni `.btn-primary`.

Superficies del lote, cerradas: Usuarios · Producto · Inventario · Agregar ítem a la orden · Notas de
la orden · «Acceso del equipo».

---

## 1. Problema y causa raíz

Varios CTAs de flujos core están escritos con estilos en línea: fondo de acento (índigo / gradiente)
y `color: '#fff'`. En tema oscuro se ven bien. En tema claro quedaban con **texto casi negro sobre
índigo**.

La causa está documentada en `src/index.css`. El tema claro tiene un barrido que adapta los estilos
en línea pensados para fondo oscuro, y una de sus reglas remapea todo texto claro en línea:

```css
[data-theme="light"] :is(
  [style*="color: rgb(248, 250, 252)"], …, [style*="color: rgb(255, 255, 255)"]
):not(…) { color: var(--text-primary) !important; }
```

Esa regla hace bien su trabajo con un título blanco sobre una tarjeta que en claro pasa a ser
blanca. Pero no distingue ese caso del de un botón cuyo fondo **sigue siendo índigo** en los dos
temas: ahí oscurece el texto y deja el fondo.

### Por qué no se tocó la regla global

Relajarla arregla estos botones y rompe todo lo demás: en el repo hay decenas de textos blancos en
línea que dependen de ella para verse sobre las superficies claras. Tampoco sirve forzar el blanco
por encima (`!important`): la regla ya es `!important` y ganaría la especificidad, no la intención.

La salida ya existía. PRE-BETA-3A-0 creó un token invariante de tema para exactamente este caso:

```css
:root { --text-on-accent: #ffffff; }
```

Un `color: 'var(--text-on-accent)'` en línea se serializa como `color: var(--text-on-accent)`: no
contiene `rgb(255, 255, 255)`, el selector no lo alcanza y el texto queda blanco en los dos temas.
Es explícito: cada CTA declara que su texto va sobre un fondo de acento.

## 2. Lo que apareció al medir

El lote pedía medir el contraste real, no afirmarlo mirando el código. Al medir, el arreglo previsto
—cambiar sólo el color de texto— no alcanzaba en la mayoría de los CTAs.

Medido en Chromium, sobre los píxeles pintados de cada fondo:

| Fondo | Texto blanco | Tinta `#0f172a` |
|---|---|---|
| Gradiente legacy `#6366f1 → #8b5cf6` | **4,20 – 4,50** | 3,96 – 4,25 |
| Gradiente de Producto `#6366f1 → #4f46e5` | 4,47 – 6,29 | 2,84 – 4,00 |
| Un tono más oscuro `#4f46e5 → #7c3aed` | 5,67 – 6,33 | 2,82 – 3,15 |
| Índigo plano `#6366f1` | **4,47** | 4,00 |
| Ámbar `#f59e0b` | **2,15** | 8,31 |
| Rojo `#ef4444` | **3,76** | 4,74 |
| Verde `#10b981` | **2,54** | 7,04 |

Tres consecuencias:

1. **Sobre el gradiente legacy el blanco no llega a 4,5:1 en ningún punto.** Con el token, esos CTAs
   pasaban de 3,99 a 4,26: mejoran a la vista, pero siguen por debajo de AA, y un gate de 4,5 no
   podía distinguir el arreglo de la regresión.
2. **Sobre ámbar, rojo y verde el blanco tampoco llega**, y ahí sí alcanza una tinta oscura. En claro
   esos botones ya se veían bien *por accidente* (el mismo barrido oscurecía su texto); el defecto
   real estaba en oscuro, donde el blanco se quedaba blanco.
3. El gradiente de Producto sí llega con blanco debajo del texto.

**Decisión del owner (consultada durante el lote):** oscurecer un tono el fondo de los CTAs que usan
el gradiente legacy —mismo índigo → violeta, `#4f46e5 → #7c3aed`— para que el contrato de 4,5:1 sea
estricto en los dos temas. El costo, asumido: esos botones quedan apenas más oscuros también en tema
oscuro, y un tono distintos del CTA del embudo de auth, que no se toca en este lote (§9).

El mismo criterio se aplicó a los dos fondos **planos** `#6366f1` del modal de ítems (la opción
activa de «Tipo» y de «Moneda · ARS»): con blanco medían 4,47:1 y pasan a `#4f46e5` (6,29:1).

## 3. Qué cambió

### Tokens

`src/lib/tokens.ts` — un grupo nuevo, `accentCta`, que es de donde sale ahora el texto y el fondo de
estos CTAs:

| Token | Valor | Para qué |
|---|---|---|
| `accentCta.text` | `var(--text-on-accent)` | texto sobre fondo de acento |
| `accentCta.background` | `linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)` | el fondo de acento con gradiente |
| `accentCta.solid` | `#4f46e5` | el fondo de acento plano (opción activa de un selector) |
| `accentCta.textOnBright` | `var(--text-on-bright)` | tinta sobre ámbar / rojo / verde sólidos |

`src/index.css` — un token invariante nuevo, al lado del que ya existía:

```css
:root {
  --text-on-accent: #ffffff;   /* sin cambios */
  --text-on-bright: #0f172a;   /* nuevo */
}
```

No se creó ninguna clase global ni se usó `!important`.

### CTAs, uno por uno

| # | Archivo | CTA | Antes | Después |
|---|---|---|---|---|
| 1 | `UsersManagement.tsx` | «Enviar Invitación» (`invite-submit`) | gradiente legacy + `#ffffff` | `accentCta.background` + `accentCta.text` |
| 2 | | «Guardar permisos» | ídem (comparten `primaryButtonStyle`) | ídem |
| 3 | `ProductFormModal.tsx` | `product-form-save-button`: «Guardar producto» / «Guardar cambios» / «Guardando...» / «Reintentar stock inicial» | `#6366f1 → #4f46e5` + `#fff` | mismo fondo + `accentCta.text` |
| 4 | | «Seguir editando» (cambios sin guardar) | ídem | ídem |
| 5 | | «Restaurar borrador» | ídem | ídem |
| 6 | | «Cerrar» (pantalla de error del formulario) | ídem | ídem |
| 7 | `Inventory.tsx` | «Reintentar» (error de carga) | gradiente legacy + `#ffffff` | `accentCta.background` + `accentCta.text` |
| 8 | | «Agregar Primer Producto» (`inventory-new-product-empty`) | ídem | ídem |
| 9 | | submit del modal de variantes («Crear Variante») | ídem | ídem |
| 10 | | «Agregar Variante» | ídem | ídem |
| 11 | | «Ver stock bajo» | fondo activo `#f59e0b`; `#ffffff` siempre | activo: `accentCta.textOnBright` · inactivo: `var(--text-primary)` |
| 12 | | «Ver agotados» | fondo activo `#ef4444`; `#ffffff` siempre | ídem |
| 13 | | moneda de una variante (ARS / USD), opción activa | `#fff` | `accentCta.text` |
| 14 | `ModalAgregarItem.tsx` | «Agregar repuesto» / «Agregar servicio» | gradiente legacy + `#fff` | `accentCta.background` + `accentCta.text` |
| 15 | | el mismo botón mientras envía («Guardando...») | gris `#374151` + `#fff` | mismo gris + `var(--text-primary)` |
| 16 | | «Tipo»: Repuesto / Servicio, opción activa | `#6366f1` + `#fff` | `accentCta.solid` + `accentCta.text` |
| 17 | | «Moneda»: ARS activo | `#6366f1` + `#fff` | `accentCta.solid` + `accentCta.text` |
| 18 | | «Moneda»: USD activo | `#10b981` + `#fff` | mismo verde + `accentCta.textOnBright` |
| 19 | `OrderDetail.tsx` | «Guardar» de las notas (`.order-notes-save`), sin guardar | gradiente legacy + `#fff` | `accentCta.background` + `accentCta.text` |

Notas:

- **Copys, handlers, `data-testid`, estados deshabilitados, sombras y medidas: sin cambios.** El estado
  «✓ Guardado» de las notas conserva su estilo.
- **15** merece una línea. Mientras envía, el botón deja de tener fondo de acento: es gris, y el
  barrido de tema claro convierte ese gris en una superficie clara. Con el token blanco ahí, el
  texto habría quedado blanco sobre blanco. Por eso en ese estado usa el texto del tema.
- **6, 10 y 13 no se pueden alcanzar hoy** desde la interfaz (6 necesita que el formulario se rompa;
  10 y 13 viven en una rama del modal legacy que ya no se abre: ese modal sólo se abre para agregar
  una variante a un producto). Se corrigieron igual porque tenían el mismo defecto, y quedan
  cubiertos por el guard de fuente, no por el navegador.
- No son CTAs y no se tocaron: los `<Check color="#fff">` de las casillas (un atributo SVG, no un
  estilo: el barrido no los alcanza) y la perilla blanca del interruptor «El cliente paga este
  repuesto».
- `.btn-primary` (`Invitar Usuario`, `Nuevo Producto`, `Agregar ítem`) vive en CSS, no en línea: no
  es este defecto y no se tocó. Ver §9.

## 4. Contraste: antes → después

Peor punto del fondo que el texto pisa, tomado entre 375×812 y 1440×900. En **negrita**, lo que
queda por debajo de su mínimo (4,5:1; 3:1 para el estado deshabilitado).

| Superficie | CTA | Estado | Antes · claro | Antes · oscuro | Después · claro | Después · oscuro |
|---|---|---|---|---|---|---|
| Usuarios | Enviar Invitación | normal | **3,99** | **4,26** | 5,78 | 5,78 |
| Usuarios | Enviar Invitación | hover | **3,99** | **4,27** | 5,78 | 5,78 |
| Usuarios | Guardar permisos | normal | **3,99** | **4,26** | 5,78 | 5,78 |
| Producto | Guardar producto | normal | **3,01** | 4,72 | 4,72 | 4,72 |
| Producto | Guardar producto | hover | **3,01** | 4,72 | 4,72 | 4,72 |
| Producto | Seguir editando | normal | **3,19** | 4,98 | 4,98 | 4,98 |
| Producto | Restaurar borrador | normal | **3,14** | 4,96 | 4,96 | 4,96 |
| Inventario | Ver stock bajo | inactivo | 16,00 | 13,84 | 16,00 | 12,58 |
| Inventario | Ver stock bajo | activo | 8,31 | **2,15** | 8,31 | 8,31 |
| Inventario | Ver agotados | inactivo | 16,00 | 14,43 | 16,00 | 13,12 |
| Inventario | Ver agotados | activo | 4,74 | **3,76** | 4,74 | 4,74 |
| Inventario | Agregar Primer Producto | normal | **3,99** | **4,25** | 5,78 | 5,78 |
| Inventario | Reintentar | normal | **3,99** | **4,28** | 5,84 | 5,84 |
| Inventario | Crear Variante | normal | **3,99** | **4,27** | 5,80 | 5,80 |
| Agregar ítem | Agregar repuesto | normal | **3,99** | **4,27** | 5,82 | 5,82 |
| Agregar ítem | Agregar repuesto | hover | **4,00** | **4,29** | 5,89 | 5,89 |
| Agregar ítem | Agregar servicio | normal | **3,99** | **4,27** | 5,82 | 5,82 |
| Agregar ítem | Tipo · Repuesto | activo | **4,00** | **4,47** | 6,29 | 6,29 |
| Agregar ítem | Tipo · Servicio | activo | **4,00** | **4,47** | 6,29 | 6,29 |
| Agregar ítem | Moneda · ARS | activo | **4,00** | **4,47** | 6,29 | 6,29 |
| Agregar ítem | Moneda · USD | activo | 7,04 | **2,54** | 7,04 | 7,04 |
| Agregar ítem | Guardando... | enviando | 3,46 | 4,11 | 3,46 | 3,84 |
| Notas de la orden | Guardar | normal | **4,00** | **4,27** | 5,80 | 5,80 |
| Notas de la orden | Guardar | hover | **4,00** | **4,27** | 5,80 | 5,80 |
| Acceso del equipo | Cifrado · interno | normal | **1,00** | 16,68 | 9,28 | 10,53 |
| Acceso del equipo | PIN configurado | normal | 14,78 | **1,13** | 17,10 | 15,81 |

89 medidas por corrida. Antes: **60** por debajo de su mínimo. Después: **0**. El mínimo entre los
CTAs de 4,5:1 es 4,72 («Guardar producto»).

Lecturas:

- El defecto original se ve en la columna «Antes · claro» de los CTAs índigo: 3,0 – 4,0.
- «Antes · oscuro» muestra lo que el lote no buscaba y encontró: el gradiente legacy con blanco
  (4,26) y los fondos de estado con blanco (2,15 / 2,54 / 3,76) ya fallaban en oscuro.
- Ningún hover cambia el fondo: se midió y da lo mismo que el estado normal.
- «Guardando...» baja de 4,11 a 3,84 en oscuro porque el texto pasa de blanco puro al blanco suave
  del tema. Es un estado deshabilitado (`button:disabled` tiene `opacity: 0.5`): WCAG lo exime y sólo
  se exige que se siga leyendo.

## 5. «Acceso del equipo»

`DeviceLockCard` tenía tres textos que no declaraban color. Dentro de una `.card` heredan el de
Bootstrap, que no sigue al tema:

| Texto | Qué pasaba | Medido | Ahora |
|---|---|---|---|
| Etiqueta «Cifrado · interno» | era un `.badge` a secas: Bootstrap le da `color: #fff` y ningún fondo. Blanca sobre la tarjeta blanca | **1,00:1** en claro | `.badge.device-lock-badge`: 9,28:1 en claro, 10,53:1 en oscuro |
| Estado («PIN configurado») | `#212529` de Bootstrap sobre la tarjeta oscura | **1,13:1** en oscuro | `var(--text-primary)`: 17,10 / 15,81 |
| Ícono del encabezado | el mismo `#212529` heredado | invisible en oscuro | `var(--text-secondary)` |

Para la etiqueta no sirvió ninguna variante existente. Se midieron en la misma tarjeta:

| Variante | Claro | Oscuro |
|---|---|---|
| `.badge-neutral` (la de `AppBadge` por defecto) | **2,56** | **2,11** |
| `.badge-info` | **2,55** | 4,96 |
| `.badge-primary` | 5,67 | **3,53** |
| `.badge-cyan` | **3,44** | 6,43 |

Por eso lleva una clase propia y mínima, hecha sólo con tokens que existen en los dos temas:

```css
.badge.device-lock-badge {
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-strong);
}
```

Doble clase para ganarle a Bootstrap sin depender del orden de carga. Sigue siendo un `.badge` (forma,
tamaño y punto), así que en oscuro se ve como antes pero con superficie.

El estado y el ícono no estaban en el pedido literal de este lote, pero son el mismo hallazgo de
BETA-UX-1D (§13.5 de su documento) y viven en la tarjeta que se estaba corrigiendo: un token cada uno.

No se tocó nada más de la tarjeta: `reveal_order_device_access`, secretos, permisos, cifrado,
auditoría, ni los botones Guardar / Revelar / Configurar / Eliminar (son `AppButton`, del design
system).

## 6. Cómo se mide

`tests/e2e/helpers/contrast.ts` ya tenía `contrastOf`, que compone los `background-color` de los
ancestros. **No sirve para un gradiente**: un `linear-gradient(…)` es `background-image`, el botón no
tiene `background-color`, y la medida termina comparando el texto contra la tarjeta de atrás. Con ese
helper, texto blanco sobre el gradiente da 1,0:1 (blanco contra la página blanca) y texto oscuro
sobre el mismo gradiente da más de 15:1. Los dos números son falsos, y el segundo habría dado verde
con el defecto presente.

Se agregó `paintedContrastOf`:

1. ubica la caja que ocupan los glifos del elemento (no la del botón: la del texto);
2. la trae al centro del viewport y comprueba que nada la tape (`elementFromPoint` en cinco puntos);
3. la captura, oculta los glifos y la vuelve a capturar;
4. el **fondo** son los píxeles de la segunda captura, y se toma el de peor contraste;
5. el **texto** es el color computado si el elemento es opaco; si algún ancestro tiene opacidad, el
   color con el que quedaron pintados los glifos (el píxel que más se aparta de su fondo).

Los glifos se ocultan con un atributo `data-*` y una regla inyectada, sin escribir en el `style` del
elemento: el barrido de tema claro matchea por `[style*=…]` y medirlo no puede alterarlo. El spec
corre con 2 píxeles de dispositivo por píxel CSS para que un texto de 11–14 px tenga núcleo.

El primer test del spec **calibra el instrumento** contra pares conocidos: blanco sobre `#4f46e5` da
6,29; sobre `#f59e0b`, 2,15; sobre el gradiente legacy, entre 4,15 y 4,50 y *variando*. Y deja
asentados los dos números falsos del helper anterior sobre ese mismo gradiente: 1,0 con texto blanco
y más de 15 con el texto oscuro del defecto, que la medida pintada sí reprueba.

## 7. Tests

### Componentes y fuente — `npm run test:beta-ux-1e` (job `quality`)

jsdom no aplica `index.css` ni pinta: ahí **no se mide contraste**. `betaUx1eAccentContrast.test.tsx`
(37 tests) fija lo que hace que la medida del navegador no pueda volver a caerse:

| Bloque | Qué fija |
|---|---|
| Tokens | `accentCta` apunta a los dos tokens de texto; los dos son invariantes de tema (un valor, un solo lugar); el blanco llega a 4,5:1 en **todas** las paradas de `accentCta.background` y sobre `accentCta.solid`; el gradiente legacy no llegaba y el fondo no puede volver a ser ése; la tinta llega sobre ámbar, rojo y verde, donde el blanco no (aritmética WCAG) |
| El barrido de tema claro | sigue siendo el mismo: las seis entradas de la regla y su `!important`; nadie fuerza el blanco por encima; un `#fff` en línea cae en él y los tokens no (y se comprueba que jsdom conserva el `var(…)`, para que el test no pase vacío) |
| Fuente de las seis superficies | por AST: **ningún estilo con fondo de acento declara blanco literal como `color`** (regla general, por archivo); y cada CTA identificado usa el token y el fondo que le corresponde, incluidos los que el navegador no alcanza |
| «Cifrado · interno» | la regla existe, declara texto, fondo y borde con tokens, sin ningún color literal; esos tokens están definidos en el tema oscuro y en el claro; montada, la etiqueta lleva la clase propia y las acciones siguen ahí; el estado y el ícono declaran color de tema |
| El DOM | `ProductFormModal` y `ModalAgregarItem` montados: el `style` que termina en el elemento lleva el token y no cae en el barrido; los selectores cambian de token al cambiar de opción |

El guard de fuente está **acotado a los seis archivos del lote**: no obliga a limpiar el resto de los
blancos en línea del repo.

Corre con las suites vecinas que montan estas pantallas: `prebeta3a0Guardrails` (el token original),
`g2c3a2ProductFormModal`, `g2c3a2InventoryPage`, `invitationsLifecycle`, `prebeta2fInvitationDelivery`
(Usuarios), `betaUx1dOrderDetail`, `orderDetailHistory` y `betaUx1dResponsiveContract` (el orden de los
bloques de `index.css`).

### Navegador — `npx playwright test --project=m7-local --grep @beta-ux-1e` (job `e2e-local`)

`tests/e2e/m7/cta-contrast.spec.ts`, 40 tests. Cada superficie en claro y en oscuro, a 375×812 y a
1440×900:

- **Usuarios** — «Enviar Invitación» (normal y hover) y «Guardar permisos».
- **Producto** — «Guardar producto» (normal y hover), «Seguir editando» y «Restaurar borrador».
- **Inventario** — los dos filtros de stock, inactivos, activos y al dejar de estarlo; «Agregar Primer
  Producto»; «Reintentar»; «Crear Variante».
- **Agregar ítem** — el CTA en sus dos copys (normal y hover), los selectores activos de tipo y de
  moneda, y «Guardando...» mientras envía.
- **Notas de la orden** — «Guardar» (normal y hover).
- **Acceso del equipo** — la etiqueta, el estado y el ícono (éste a 3:1, WCAG 1.4.11).

Además de la medida, cada CTA: es visible, recibe el click (`trial`, sin darlo), su texto no queda
recortado por el propio botón y no se sale de la pantalla. «Guardar» de las notas conserva sus 44 px en
mobile (contrato de BETA-UX-1D).

**No se guarda, invita ni borra nada para medir.** El estado vacío y el de error de Inventario se
obtienen respondiendo la lista desde el navegador. Para «Guardando...» se retiene el alta, se mide y
se aborta; el test comprueba en la base que no se escribió ningún ítem.

Datos: las órdenes del fixture de BETA-UX-1D y uno propio (`seedCtaContrastFixture.ts`) con un producto
de stock bajo, uno agotado y un usuario editable del negocio.

### Controles negativos

Se reintrodujo cada defecto, de a uno, se reconstruyó el bundle y se corrieron los gates. Cada
mutación se restauró y el árbol quedó idéntico (hashes).

| # | Defecto reintroducido | Componentes | Navegador |
|---|---|---|---|
| 1 | `color: '#fff'` en «Guardar producto» | rojo (3) | rojo (2) |
| 2 | `color: '#fff'` en el submit de «Agregar ítem» | rojo (3) | rojo (2) |
| 3 | `color: '#fff'` en «Guardar» de las notas | rojo (2) | rojo (2) |
| 4 | el `primaryButtonStyle` viejo de Usuarios | rojo (4) | rojo (7) |
| 5 | «Cifrado · interno» vuelve a ser un `.badge` a secas | rojo (2) | rojo (2) |
| 6 | «Ver stock bajo» vuelve a blanco | rojo (2) | rojo (2) |
| 7 | *(extra)* se deja el token de texto pero el fondo vuelve al gradiente legacy | rojo (2) | rojo (11 de 11) |
| 8 | *(extra)* «Agregar ítem» usa el token blanco también mientras envía | rojo (1) | rojo (1) |
| 9 | *(extra)* «Moneda · USD» activo con el token blanco | rojo (2) | rojo (4) |
| 10 | *(extra)* el estado de «Acceso del equipo» vuelve a no declarar color | rojo (1) | rojo (2) |
| 11 | *(extra)* se «arregla» relajando el barrido global de tema claro | rojo (2) | no aplica |

Entre paréntesis, la cantidad de tests que fallaron. Las once fueron detectadas.

- **7** es el control de la decisión de §2: con sólo el token, los once tests de Usuarios y de Notas
  quedan rojos.
- **8** es el caso que el arreglo mecánico habría roto: blanco sobre una superficie clara.
- **11** no tiene control de navegador porque, con el barrido relajado, estos CTAs se ven bien: lo que
  se rompe es todo lo demás. Lo detecta el test que fija la regla.

Como «antes» se corrió además el spec completo con las ocho fuentes del lote revertidas a la base:
32 de 40 tests rojos. Los 8 verdes son el instrumento y lo que ya pasaba: Producto en oscuro (3), los
filtros de Inventario en claro (2) y «Guardando...» (2).

### Resultados medidos (local, 2026-10-09, base `main` `2e1d0e5`)

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint src --quiet` | 0 errores |
| `npm run test:beta-ux-1e` | 9 archivos · **210 / 210** (37 son el archivo nuevo) |
| Suite de componentes completa | 135 archivos · **2.895 / 2.895** en una de dos corridas. En la otra falló por timeout `orderIntakeMobile › … el scanner ABRE igual` (escáner de la recepción; este lote no toca ese módulo): aislado pasa 8 / 8, y es un test que ya se sabía sensible a la carga de la máquina |
| `node --test tests/unit` | **1.215 / 1.215** |
| Guards | `sec08a` (+ self-test), `sec08a-phase-b` (+ self-test), `sec08a-phase-c`, `order-payment-status`, `finance-writes`, `customer-core`, `mobile2a`, `onboarding-canonical`, `ui-governance`, `no-real-data` (+ self-test, 28 / 28): todos en verde |
| `vite build` (variables de CI) | correcto |
| E2E `@beta-ux-1e` — Chromium, `m7-local` | **40 / 40** · 89 medidas, 0 por debajo de su mínimo |
| E2E `m7-local` completo | **331 / 331** (14,8 min) sobre un stack local aislado con las 285 migraciones. Incluye a los vecinos que usan estas pantallas: `prebeta2f-invitation-email` (Usuarios), `g2c3a2-stock-authority` (Producto e Inventario) y `mobile-orders` (detalle de orden). Después de esa corrida sólo cambiaron archivos de test (dos aserciones más en la calibración, un localizador, el recorte de una captura y el lienzo del helper) y este documento; el spec de 1E se volvió a correr completo en los dos motores |
| Specs legacy vecinos (proyecto `chromium`, que CI no corre) | 11 specs, 44 tests, corridos sobre la rama y sobre la base contra el mismo backend: **ninguno empeora**. Dos difieren, a favor de la rama, y ninguno por este cambio: `stock-sale` depende del orden de corrida (al invertirlo quedan idénticos) e `inventory-product-history › carga sin crash` exige cero errores de consola y tropieza con un RPC abortado al navegar que aparece en las dos builds (§9.11) |
| El mismo spec en **WebKit real** (motor de Safari / iOS) | **40 / 40** · 89 medidas, 0 por debajo de su mínimo; el mínimo es 4,74. El proceso de WebKit sobre Windows no cierra solo al terminar (ya pasaba en BETA-UX-1D): los 40 tests reportaron `ok` y se lo cortó a mano |
| Controles negativos | **11 / 11** detectados |

La primera pasada en WebKit sirvió: `paintedContrastOf` usaba `OffscreenCanvas`, que el WebKit de
Playwright no trae, y los 40 tests fallaban en la medida. Ahora usa un `<canvas>` suelto y corre en
los dos motores. La corrida final de Chromium (40 / 40) es posterior a ese cambio y da la misma
tabla de §4, byte a byte.

## 8. Evidencia

`docs/beta-ux-1/evidence-1e/`, generada por el spec con `BETA_UX_1E_EVIDENCE=<carpeta>`. Las `antes-*`
salen de la misma corrida con las fuentes revertidas a la base.

| Captura | Qué muestra |
|---|---|
| `antes-users-invite-light.png` → `users-invite-light.png` | «Enviar Invitación» en claro: texto oscuro sobre índigo → blanco |
| `product-save-light.png` | el pie del formulario de producto en claro |
| `antes-inventory-actions-dark.png` → `inventory-actions-dark.png` | «Ver stock bajo» activo en oscuro: blanco sobre ámbar → tinta |
| `inventory-actions-light.png` | lo mismo en claro (se ve igual que antes) |
| `antes-add-item-light.png` → `add-item-light.png` | el modal de ítems en claro: CTA y selectores activos |
| `add-item-dark.png` | control en oscuro |
| `antes-order-notes-light.png` → `order-notes-light.png` | «Guardar» de las notas en claro |
| `antes-device-lock-badge-light.png` → `device-lock-badge-light.png` | la etiqueta, que en claro no se veía |
| `antes-device-lock-badge-dark.png` → `device-lock-badge-dark.png` | el estado y el ícono, que en oscuro no se veían |

Las capturas acompañan a las medidas; no las reemplazan.

## 9. Fuera de alcance — hallazgos

No se tocaron. Los números son medidas de este lote, con el mismo instrumento.

1. **P1 · `.btn-primary`, el botón primario global, no llega a AA.** Su fondo es
   `--gradient-primary` (índigo → cyan) con texto blanco declarado en CSS. Bajo el texto mide
   **2,67 – 4,08:1 en oscuro** y **4,01 – 5,92:1 en claro** (medido en «Invitar Usuario», «Nuevo
   Producto» y «Agregar ítem»). El extremo cyan es el problema: blanco sobre `#06b6d4` da 2,4:1 por
   fórmula. No es el defecto de este lote (no hay blanco en línea ni depende del tema) y arreglarlo es cambiar el
   gradiente de marca en toda la aplicación: necesita su propia decisión.
2. **P2 · El CTA del embudo de auth usa el gradiente legacy.** «Iniciar sesión» mide **4,32 – 4,44:1**
   en los dos temas (`authCardStyles.btnPrimary`: `#6366f1 → #8b5cf6` con `--text-on-accent`). Mismo
   caso que §2. Después de este lote queda un tono más claro que los CTAs de adentro.
3. **P2 · Las variantes de `AppBadge` no llegan a AA en al menos un tema** (tabla de §5; además
   `.badge-warning` 1,96 y `.badge-success` 2,05 en claro). `.badge-neutral`, la variante por defecto,
   falla en los dos.
4. **P2 · «✓ Guardado» de las notas mide 2,21:1 en claro** (verde `#10b981` sobre verde claro); 5,16 en
   oscuro. Es un estado de dos segundos y el lote pedía conservarlo.
5. **P2 · «No tenés permiso para consultar el acceso del equipo»** usa `--text-subtle`, el mismo token
   que deja a `.badge-neutral` en 2,1 – 2,6:1. No se midió en pantalla (hace falta un actor sin el
   permiso).
6. **P2 · Dentro de una `.card`, un texto sin color propio hereda `#212529` de Bootstrap** y en oscuro
   desaparece. `DeviceLockCard` era un caso; puede haber otros.
7. **P3 · El modal legacy de Inventario conserva ramas que ya no se abren** («Agregar Variante», la
   lista de variantes con su selector de moneda): sólo se abre para agregar una variante a un producto.
8. **P3 · El estado vacío de Inventario sigue dentro de un `<td colSpan>`** (lo que BETA-UX-1D sacó de
   Órdenes y Clientes). En mobile queda dentro del scroll de la tabla. Inventario mobile es un lote
   posterior.
9. **P3 · `contrastOf` se sigue usando en otros specs** y tiene la limitación de §6: es correcto sobre
   fondos planos y no ve gradientes. No se revisó qué mide en cada uno.
10. Siguen pendientes de BETA-UX-1D y no eran de este lote: el `STATUS_MAP` de la hoja impresa, la
    falla transitoria de `auth.getUser` en Clientes, el estado vacío falso durante la carga.
11. **P3 · Un error de consola al navegar justo después de entrar.** El RPC
    `current_user_has_internal_tool_access` queda abortado si se cambia de pantalla antes de que
    responda y `useInternalToolAccess` lo registra como error («la autoridad interna no respondió»).
    No rompe nada a la vista; hace intermitente al spec legacy que exige cero errores de consola.
    Reproducido en la base y en la rama.

No se abordó, por pedido: el resto de los textos en línea pensados para un solo tema, las tablas de
Usuarios, Inventario y Proveedores en mobile, Settings, colores de estado, el rediseño del formulario
de producto, `alert()` / `confirm()`, inputs, Dashboard y el flujo de auth.

## 10. Smoke manual sugerido (Preview, en tema claro y en oscuro)

1. Usuarios → «Invitar Usuario»: «Enviar Invitación» se lee en blanco. Editar permisos de un usuario:
   «Guardar permisos», igual.
2. Inventario → «Nuevo Producto»: «Guardar producto» en blanco. Escribir un nombre y Cancelar: «Seguir
   editando».
3. Inventario con productos en stock bajo o agotados: «Ver stock bajo» y «Ver agotados», activos, se
   leen con texto oscuro sobre ámbar y rojo en los dos temas.
4. Una orden → «Agregar ítem»: el botón de abajo, «Repuesto / Servicio» y «$ ARS / USD $».
5. La misma orden → Notas: «Guardar».
6. La misma orden → «Acceso del equipo»: la etiqueta «Cifrado · interno», el estado y el candado se ven
   en los dos temas.
