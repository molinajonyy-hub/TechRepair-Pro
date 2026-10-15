# HOTFIX BETA-UX-1G — volver de Google sin autenticarse

Rama `claude/beta-ux-1g-google-oauth-return`, desde `main` fccce50 (BETA-UX-1G ya
mergeado: PR #178, merge 33bae18).

## El síntoma

En el smoke manual de 1G: «Continuar con Google», y después cancelar o volver al
login. La pantalla quedaba para siempre en «Redirigiendo a Google…» con todos
los controles deshabilitados. Google con cuenta existente y con cuenta nueva
funcionaba bien, onboarding incluido.

## Causa raíz (demostrada)

`handleGoogleSignIn` (src/pages/Login.tsx) pone `isGoogleLoading = true` y sólo lo
vuelve a `false` en el `catch`. Cuando OAuth arranca bien, supabase-js hace
`window.location.assign(<GoTrue>/authorize…)` y la promesa **resuelve sin error**:
la página «se va» y nadie deshace la espera. Eso es correcto mientras la página
efectivamente se va. El defecto aparece cuando el usuario **sigue en esta
página** sin haberse autenticado. Hay dos maneras, y las dos están medidas en
Chrome:

1. **«Atrás» restaura la página desde el back/forward cache (bfcache).** Desde
   Google, o desde el aviso de cancelación del callback con dos «Atrás», el
   navegador no recarga `/login`: lo **restaura congelado**, con el estado de
   React de antes de irse. Botón «Redirigiendo a Google…», formulario
   deshabilitado y, además, el destino `post_login_redirect` del intento
   abandonado queda en `sessionStorage`. Sólo se dispara `pageshow` con
   `persisted: true`, y nadie lo escuchaba.
2. **La salida hacia el proveedor se interrumpe antes de dejar el login**
   («Detener», Esc o red lenta): la navegación pendiente se cancela y la página
   nunca se fue. No hay restauración, así que la página sigue igual de
   bloqueada. Chrome lo avisa por la Navigation API (`navigateerror`), y nadie
   lo escuchaba.

**Lo que NO era la causa:** «Cancelar» en Google → `/auth/callback?error=access_denied`
→ tarjeta «No iniciaste sesión» → «Volver a iniciar sesión». Ese camino monta un
login NUEVO y ya funcionaba en `main` (C1 y C1b en verde antes del fix; E2E 4 en
verde contra `main`).

### Medición antes / después (Chrome instalado, build de producción)

`docs/beta-ux-1/evidence-1g-oauth/google-return.mjs` sirve el build de
producción con `vite preview`. Supabase y «Google» son dos servidores HTTP
locales y nada se intercepta, así que la página es elegible para el bfcache como
en producción. Reportes completos: `antes-chrome.txt` (Login de `main`) y
`despues-chrome.txt` (con la corrección, `--gate`).

| Flujo | `main` | con la corrección |
|---|---|---|
| B1 · Google → Atrás | restaurada=1 · «Redirigiendo a Google…» · todo deshabilitado · destino `"/dashboard"` | «Continuar con Google» · habilitado · destino `null` |
| B2 · segundo intento después de volver | imposible | OK (y volver otra vez, restaurada=2, también) |
| B3 · contraseña después de volver | imposible | OK → `/dashboard` |
| B4 · `redirectTo=/orders` → Google → Atrás → contraseña | imposible | OK → `/orders` |
| C1 · Cancelar en Google → callback → Volver | OK | OK |
| C1b · … → Volver → contraseña con `redirectTo=/orders` | OK → `/orders` | OK → `/orders` |
| C2 · Cancelar → callback → Atrás, Atrás | bloqueado | OK |
| I1 · /authorize no contesta → el navegador detiene la carga | bloqueado · destino `"/dashboard"` · `navigateerror`=1 | OK · destino `null` · Google se reintenta |
| S · Google cuenta existente | `/dashboard` | `/dashboard` |
| S · Google cuenta nueva | `/no-business` | `/no-business` |
| S3 · `redirectTo=/orders` → Google cuenta existente | `/orders`, destino consumido | `/orders`, destino consumido |
| **Resultado** | **9 comprobaciones no cumplidas** | **todas se cumplen** |

Capturas: `antes-B1-volver-de-google.png` / `despues-B1-volver-de-google.png`,
`antes-I1-carga-detenida.png` / `despues-I1-carga-detenida.png`,
`despues-C1-cancelar.png` (la tarjeta del callback, igual antes y después).

### Por qué ningún E2E lo había visto (control del instrumento)

Playwright lanza Chromium con `--disable-back-forward-cache` entre sus argumentos
por defecto, y el «headless shell» que usa el proyecto **no restaura ninguna
página desde el historial, ni una trivial**. `bfcache-probe.mjs` lo mide con dos
páginas HTML sin la app (`bfcache-probe.txt`):

| Navegador (sin `--disable-back-forward-cache`) | ¿Restaura? |
|---|---|
| chromium, headless shell (el de siempre) | no (`notRestoredReasons: masked`) |
| `channel: 'chromium'` (Chromium completo, lo instala el mismo `playwright install chromium`) | sí |
| `channel: 'chrome'` (Chrome instalado) | sí |
| `channel: 'msedge'` | sí |
| webkit (Playwright en Windows) | no |

Por eso el spec nuevo lanza SU PROPIO Chromium completo y verifica, como
precondición, que la página efectivamente volvió desde el bfcache (si no, el
spec no probaría nada).

## La corrección (src/pages/Login.tsx, +46 líneas con comentarios, sin cambios visuales)

- `googleEnCursoRef`: hay una ida a Google pedida desde ESTA página. Se marca
  **antes** de `await signInWithGoogle()`, porque la página puede quedar
  congelada en cuanto el navegador sale. Se desmarca en el `catch` (error al
  iniciar OAuth, que ya tenía su recuperación).
- Un efecto escucha las dos señales del ciclo de navegación:
  - `pageshow` con `event.persisted`: la página volvió desde el historial;
  - `navigateerror` de la Navigation API, cuando existe: la navegación
    pendiente no terminó.
- Con cualquiera de las dos, y **sólo si hay una ida a Google en curso**, se
  deshace lo que dejó esa ida: `isGoogleLoading = false` y
  `clearPostLoginRedirect()`. El destino pedido no se pierde porque sigue en la
  URL (`redirectTo` / `from`), y el próximo intento lo vuelve a guardar.
- Sin mensaje de error: volver no es una falla.

### Por qué no introduce carreras

- **Sin temporizador.** La espera no se corta sola mientras el navegador sale,
  por lenta que sea la red (G8 adelanta 10 minutos de reloj y sigue esperando).
  Un timeout reabriría el botón con la salida todavía en curso: doble ida, o el
  destino borrado antes de que el callback lo lea.
- **Un éxito no dispara nada.** `pageshow` restaurado sólo ocurre al VOLVER, y
  `navigateerror` sólo si la navegación se cancela. Medido: S3 llega a `/orders`
  con el destino guardado consumido por el callback, así que no hubo un borrado
  espurio durante la salida.
- **Idempotente.** El ref se lee y se baja antes de tocar nada: si llegaran las
  dos señales, una sola deshace.
- **Acotado.** Sin ida en curso, ninguna de las dos señales toca nada (G3, G12).
  Tras un error de arranque tampoco (G6). Desmontado el login, deja de escuchar
  las dos (G9).
- **Mientras la ida está en curso todos los controles están deshabilitados**, así
  que la única navegación pendiente de esta página es la del proveedor.

### Alternativas descartadas

- `pagehide`: dispara al salir, también en el éxito. Resetear ahí obligaría a
  confiar en que React pinte mientras la página se congela, y no se podría
  borrar el destino (el callback lo necesita).
- `visibilitychange`: dispara al cambiar de pestaña o de app con la salida
  todavía en curso, que es justo la carrera a evitar.
- Recargar la página al volver (`pageshow` → `location.reload()`): funciona, pero
  descarta lo que el usuario había escrito y cuesta una carga entera por algo
  que se resuelve con dos estados.

## Límites conocidos (declarados, no ocultos)

- **Sin Navigation API no hay señal para la carga detenida (I1).** Chromium
  (Chrome, Edge, Chrome de Android) la tiene. En Safari y Firefox es reciente y
  **no lo verifiqué acá**. Sin ella, ese caso queda como en `main` hasta recargar;
  el caso del «Atrás» (bfcache) se cubre igual porque `pageshow` es universal
  (G13).
- **Safari / WebKit con bfcache no se pudo automatizar en esta máquina**
  (Playwright WebKit en Windows no restaura ni una página trivial). Queda para
  el smoke humano en iPhone.
- **El viaje real a Google** (cuenta existente, cuenta nueva, «Cancelar» en el
  consentimiento) no se automatiza. En los tests es un proveedor simulado, y en
  el E2E GoTrue local contesta 400 porque Google no está habilitado ahí; el
  contrato que se mide es la VUELTA. Queda para el smoke humano.
- **Caso borde (no es regresión):** si en la misma pestaña alguien completa
  Google, llega al producto y vuelve con «Atrás» varias veces hasta el login
  congelado, ese login ahora aparece **usable** (antes, bloqueado). Una recarga o
  cualquier ingreso lo lleva al producto: la sesión es la de siempre.

## Tests

| Qué | Dónde | Con la corrección | Contra `Login.tsx` de `main` |
|---|---|---|---|
| Unitarios (jsdom, AuthProvider real, Supabase simulado) | `tests/components/betaUx1gGoogleReturn.test.tsx` · en `npm run test:beta-ux-1g` (CI) | 15/15 | 8 fallan (G1, G4, G5, G8, G9, G11, G13, contrato) · 7 pasan (no regresión) |
| E2E navegador real con bfcache, stack local | `tests/e2e/m7/google-oauth-return.spec.ts` (job `e2e-local`) | 5/5 (`e2e-despues.txt`) | 4 fallan (1, 2, 3, 5) con «Redirigiendo a Google…» · el 4 pasa (`e2e-antes-main.txt`) |
| Reproducción Chrome instalado, build de producción | `evidence-1g-oauth/google-return.mjs --gate` | todas OK | 9 no cumplidas |

Casos exigidos por el hotfix → cobertura:

| Caso | Cobertura automática | Pendiente humano |
|---|---|---|
| Google cuenta existente | repro S (simulado), G10 | sí: Google real |
| Google cuenta nueva | repro S (simulado), G10 | sí: Google real |
| Cancelación explícita | repro C1/C1b/C2, E2E 4, G7 | sí: «Cancelar» en el Google real |
| Botón Atrás | repro B1/B2/B4, E2E 1–3, G1 | sí: iPhone Safari |
| Restauración bfcache | repro (restaurada=1/2), E2E (precondición), G1/G2 | sí: iPhone Safari |
| Error al iniciar OAuth | G6 | — |
| Segundo intento tras cancelar/volver | repro B2/C1/I1, E2E 2/4/5, G4/G11 | — |
| Contraseña tras cancelar/volver | repro B3/B4/C1b, E2E 3, G5/G7 | — |
| Destino posterior seguro | repro B4/C1b/S3, E2E 3/4, G5/G7/G10 | — |
| Ningún loading infinito | todo lo anterior + I1, E2E 5, G8, G11 | Safari sin Navigation API: ver límites |

## Smoke manual

En el entorno donde se hizo el smoke de 1G (el dominio con Google habilitado). No
hace falta tocar la configuración de Supabase Auth.

1. **Chrome escritorio · Atrás desde Google.** `/login` → «Continuar con Google» →
   en la pantalla de Google, botón Atrás del navegador. Esperado: «Continuar con
   Google», email, contraseña y pestañas habilitados, sin mensaje de error.
2. **Segundo intento.** Desde (1), «Continuar con Google» otra vez: vuelve a
   abrir Google.
3. **Contraseña después de volver.** Desde (1), ingresar con email y contraseña:
   entra al panel.
4. **Destino pedido.** Sin sesión, abrir `/orders` (rebota al login) → Google →
   Atrás → contraseña. Esperado: termina en `/orders`.
5. **Cancelar en Google** (si Google muestra «Cancelar» en el consentimiento):
   tarjeta «No iniciaste sesión» → «Volver a iniciar sesión» → login usable.
   Desde la tarjeta, probar también Atrás, Atrás: el login original, usable.
6. **Carga interrumpida.** DevTools → Network → «Slow 3G» → «Continuar con
   Google» → apretar «Detener» (X) o Esc antes de que cargue Google. Esperado:
   el login vuelve a «Continuar con Google», usable.
7. **iPhone Safari** (pendiente humano): (1) con el gesto o botón Atrás, y (3).
   Si Safari no restaura desde el historial, el login simplemente recarga: también
   es correcto.
8. **Android Chrome:** (1) con el gesto Atrás del sistema.
9. **Sin regresión:** Google con una cuenta existente → panel; Google con una
   cuenta nueva → onboarding. Igual que en el smoke de 1G.

## Cómo repetir la evidencia

```
node docs/beta-ux-1/evidence-1g-oauth/bfcache-probe.mjs <worktree>
node docs/beta-ux-1/evidence-1g-oauth/google-return.mjs <worktree> <tmp> <reporte.txt> --canal=chrome --capturas=<prefijo> --gate
npx playwright test --project=m7-local tests/e2e/m7/google-oauth-return.spec.ts
npm run test:beta-ux-1g
```

## Alcance

- Sólo `src/pages/Login.tsx`. Sin cambios visuales: las capturas «después» son
  las mismas pantallas de 1G.
- Sin cambios en Supabase Auth, en el mecanismo de autenticación, en
  `/auth/callback`, en el provisioning ni en las RPC.
- Sin Mercado Pago, caja, inventario ni finanzas.
