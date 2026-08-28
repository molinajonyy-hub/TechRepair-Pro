# MOBILE-PWA-0 — identidad de instalación de TechRepair Pro

Lote: `feat/mobile-pwa-0-techrepair-install`
Baseline: `af5fd99`

## Bug de producción

Un usuario autenticado abría `techrepairpro.app` en iPhone, elegía **Agregar a
pantalla de inicio**, y el ícono instalado era **Mi Guita**: arrancaba en
`/personal` (finanzas personales), no en TechRepair Pro.

**iOS no se equivocaba.** Estaba obedeciendo nuestros metadatos.

## Causa raíz

Dos superficies del *app shell* global declaraban la identidad de Mi Guita para
**todo** el sitio, no sólo para el módulo personal:

1. `public/manifest.json` — el único manifest del sitio:
   `name: "Mi Guita — Finanzas Personales"`, `short_name: "Mi Guita"`,
   `start_url: "/personal"`, íconos `miguita-192.svg` / `miguita-512.svg` y tres
   atajos hacia `/personal`.
2. `index.html` — `<meta name="apple-mobile-web-app-title" content="Mi Guita">`
   y dos `apple-touch-icon` apuntando a los SVG de Mi Guita.

Agravante para iOS: **Safari no soporta SVG en `apple-touch-icon`**. El manifest
tampoco declaraba ningún raster. Aun con el nombre corregido, un icon-set
sólo-SVG no es una base confiable para instalar en iPhone.

## Contrato anterior → nuevo

| Campo | Antes | Ahora |
|---|---|---|
| `name` | `Mi Guita — Finanzas Personales` | `TechRepair Pro` |
| `short_name` | `Mi Guita` | `TechRepair Pro` |
| `description` | finanzas personales | gestión de taller |
| `id` | — | `/` |
| `start_url` | `/personal` | `/` |
| `scope` | `/` | `/` (sin cambio) |
| `display` | `standalone` | `standalone` (sin cambio) |
| `orientation` | `portrait` | `any` |
| `background_color` / `theme_color` | `#071018` | `#f4f7fb` |
| `lang` | `es-AR` | `es-AR` (sin cambio) |
| `categories` | `finance, productivity` | `business, productivity` |
| `icons` | 3× SVG Mi Guita (verde) | 3× PNG TechRepair (índigo/lila) |
| `shortcuts` | 3, todos a `/personal` | ninguno |
| `apple-mobile-web-app-title` | `Mi Guita` | `TechRepair Pro` |
| `apple-touch-icon` | 2× SVG Mi Guita | 1× PNG 180×180 TechRepair |

Cambios de valor que conviene notar:

- **`orientation: any`.** Mi Guita era una app de teléfono, por eso `portrait`.
  TechRepair Pro se usa además en tablet y escritorio; dejar `portrait` le
  hubiera trabado la rotación a un técnico con la tablet apaisada.
- **`theme_color: #f4f7fb`.** Es `--bg-primary` del tema **light**, que es el
  tema por defecto del shell (ver el script pre-paint de `index.html`). El
  valor anterior era el fondo oscuro de Mi Guita.
- **Sin `shortcuts`.** Los tres apuntaban a `/personal`. No se inventan atajos
  nuevos de TechRepair en este lote: eso sería diseñar una superficie de
  producto nueva sin evidencia de uso.

## Íconos: fuente elegida

Fuente: **`src/assets/logo.svg`** — el logo canónico de TechRepair Pro, el mismo
que monta el Sidebar y el mismo que ya toma
`scripts/companion/generar-iconos.mjs`.

No se recoloreó nada ni se rediseñó el logo: el gradiente índigo→violeta
(`#6366f1` → `#8b5cf6`) de la identidad **Gestión** sale tal cual del archivo.
Los `miguita-*.svg` son ese mismo gato recoloreado a verde; usarlos habría sido
la marca equivocada.

Generador idempotente: `npm run pwa:iconos`
(`scripts/pwa/generar-iconos.mjs`). Rasteriza con el Chromium de Playwright, que
ya es dependencia del repo. **Cero dependencias nuevas.**

| Archivo | Uso | Forma |
|---|---|---|
| `techrepair-192.png` | manifest `any` | esquinas transparentes (`rx=22` del logo) |
| `techrepair-512.png` | manifest `any` | ídem |
| `techrepair-maskable-512.png` | manifest `maskable` | a sangre, arte al 80% (zona segura de Android) |
| `apple-touch-icon-180.png` | iOS | a sangre y **opaco** |

Dos decisiones que no son obvias:

- **El apple-touch-icon va a sangre y opaco.** Safari ignora el alpha y aplica
  su propia máscara superelíptica; un PNG con esquinas transparentes se instala
  con marco negro alrededor del cuadrado redondeado.
- **El maskable no tiene costura.** El gradiente de respaldo replica el
  `catGradient` del SVG con los stops corridos a 10%/90%, así el tramo que cubre
  el arte al 80% coincide punto por punto con el gradiente interno.

## Arranque y sesión

`start_url: "/"` y `scope: "/"`. En `src/App.tsx`, `/` monta `<Dashboard />` bajo
`ProtectedRoute` + `MainLayout`: es la ruta canónica del dashboard, así que no se
fuerza `/dashboard` ni se duplica routing.

**No se agregó ningún bypass de auth para PWA.** Con sesión válida persistida,
`ProtectedRoute` resuelve normal; sin sesión, el flujo de login existente actúa.
`src/lib/supabase.ts` conserva `persistSession` / `autoRefreshToken` /
`detectSessionInUrl` sin tocar.

Medido sobre el build de producción servido: sembrando una clave de auth en
`localStorage` y navegando a `/`, la clave **sobrevive** al lanzamiento y la ruta
final es `/login` (no `/personal`). Ningún `localStorage.clear()` en el shell.

La persistencia entre relanzamientos, refresh de token, foreground/background,
usuarios revocados y logout los audita **MOBILE-SESSION-1**, no este lote.

## Mi Guita

Se preserva íntegro: rutas `/personal/*` y `/mi-guita`, identidad verde, lógica
de finanzas personales, y los assets `public/icons/miguita-*.svg` (quedan en el
repo justamente para el manifest propio que viene después).

`useQuickExpenseShortcut` sigue aceptando `?quickExpense=1`, `?action=quick-expense`
y `#quick-expense`: lo que se retiró es el **atajo del manifest**, no el punto de
entrada.

### Diferido — Mi Guita instalable por separado

Para que Mi Guita se instale como app propia hace falta un **segundo manifest**
(`/miguita-manifest.json`) enlazado sólo desde el shell del módulo personal, lo
que implica metadatos de `<head>` dinámicos por ruta. Es una arquitectura nueva,
no un ajuste de valores: **queda explícitamente fuera de MOBILE-PWA-0.**

### Otros diferidos

- **`apple-mobile-web-app-status-bar-style`** sigue en `black-translucent`
  (heredado de Mi Guita, que es oscura). Con el shell de TechRepair en light por
  defecto puede convenir otro valor, pero cambiarlo altera el comportamiento de
  *safe-area* —el contenido deja de pasar por debajo de la barra— y eso exige
  verificación en iPhone real. No se toca a ciegas.
- **`theme-color` dinámico por tema.** Hoy es un valor fijo (light, el default).
  El tema lo gobierna `localStorage`, no `prefers-color-scheme`, así que un
  `<meta media="...">` desincronizaría a quien tenga el SO en oscuro y la app en
  claro.

## Regresión

- `tests/unit/pwaInstallIdentity.test.ts` — 18 tests sobre los archivos
  estáticos servidos: manifest, `index.html`, PNG en disco (firma + IHDR) y
  routing.
- `scripts/guards/pwa-install-identity.mjs` — guard de CI, en la cadena
  `npm run guards`. Su `--self-test` **reintroduce** cada defecto sobre una copia
  y verifica que el guard lo caza (12 casos). Un gate que nunca se probó fallando
  no prueba nada.

## Validación humana en iPhone (post-deploy)

iOS cachea con fuerza los metadatos de una PWA ya instalada. **No se puede
prometer que el ícono ya instalado se actualice solo: hay que reinstalarlo.**

1. Eliminar el ícono de **Mi Guita** de la pantalla de inicio
   (mantener presionado → Eliminar app → Eliminar de pantalla de inicio).
2. Abrir Safari e ir a `https://techrepairpro.app`.
3. Confirmar que corre el deploy nuevo: recargar; si hace falta, cerrar la
   pestaña y volver a abrir para saltear el caché.
4. Compartir → **Agregar a pantalla de inicio**.
5. En la hoja de previsualización, el ícono debe ser el **gato índigo/lila**
   (no el verde).
6. La etiqueta propuesta debe decir **TechRepair Pro**.
7. Agregar y lanzar desde la pantalla de inicio.
8. Debe abrir el **dashboard de TechRepair Pro**, no `/personal`.
9. Con sesión válida previa, debe entrar directo; sin sesión, debe mostrar el
   login normal.

Si el paso 5 o 6 todavía muestra Mi Guita: el navegador está sirviendo el
`index.html` viejo. Repetir el paso 3.
