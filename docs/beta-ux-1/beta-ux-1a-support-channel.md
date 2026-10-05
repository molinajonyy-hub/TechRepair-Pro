# BETA-UX-1A — Ayuda que realmente llega

Cierra **P0-1** y **P1-7** del discovery BETA-UX-1 (`beta-ux-1-discovery.md`, §C).
Frontend + build + plantillas de correo de Auth. **Sin migraciones, sin `db push`, sin deploy, sin
cambios en Vercel ni en el Dashboard de Supabase.** Quedan dos pasos manuales del operador: la
variable en Vercel (§5) y pegar las plantillas en Supabase Auth (§6).

---

## 1. Decisiones del owner (2026-10-05)

| Tema | Decisión |
|---|---|
| Canal de soporte de la beta | **WhatsApp**, únicamente |
| Número | local `3574404419` · legible `+54 9 3574 404419` |
| Valor canónico (`wa.me` / `VITE_CONTACT_WHATSAPP`) | **`5493574404419`** |
| `techrepairpro.soporte@gmail.com` | **NO es un canal de soporte operativo**: el owner no lo usa ni lo monitorea como soporte. Sigue siendo el contacto institucional/legal y el publisher del Chrome Web Store |

Consecuencia de producto: ninguna pantalla puede derivar a esa casilla como «soporte», ni siquiera
como respaldo cuando falta la configuración.

---

## 2. Diagnóstico

### 2.1 Qué estaba mal

1. **P0-1.** `VITE_CONTACT_WHATSAPP` de producción valía `+594…` (13 dígitos): una transposición de
   `+549`. `normalizarWhatsApp` sólo exigía «10 a 15 dígitos», así que pasó. Ayuda, la pantalla
   global de error y el muro de fin de prueba abrían un chat con un número que no es el del soporte.
2. El pie de la landing ni siquiera pasaba por esa función: armaba `https://wa.me/${valor crudo}` y
   publicaba `wa.me/+594…`.
3. `canalSoporte()` caía **en silencio** a `mailto:` de la casilla institucional cuando la variable
   faltaba o era inválida.
4. **P1-7.** Las pantallas previas al negocio (sin acceso a `/ayuda`, que vive en `MainLayout`)
   mandaban directo a esa casilla; `link_failed` decía «Escribinos» sin ningún enlace.
5. Ningún gate miraba el valor real del build.

### 2.2 Usos de email / WhatsApp, clasificados

**A · Soporte de producto → migrado a WhatsApp**

| Superficie | Antes | Ahora |
|---|---|---|
| `src/config/contacto.ts` · `canalSoporte()` | caía a `mailto:` institucional | `no_disponible`, sin enlace |
| `NoBusiness.tsx` · usuario desactivado | `mailto:` | WhatsApp |
| `NoBusiness.tsx` · `link_failed` | «Escribinos» sin enlace | WhatsApp |
| `NoBusiness.tsx` · error al cargar el negocio (transitorio) | sólo Reintentar | Reintentar + WhatsApp |
| `VerifyEmail.tsx` · reenvío fallido / error de verificación | `mailto:` | WhatsApp |
| `ResetPassword.tsx` · enlace inválido | `mailto:` | WhatsApp |
| `authErrors.ts` · `email_send_failed` (se ve en `Login.tsx`) | la casilla como texto plano | copy sin casilla + enlace de WhatsApp en Login |
| `LandingPage.tsx` · ícono de WhatsApp del pie | `wa.me/` + valor crudo | `canalSoporte('landing')` |
| `/ayuda`, `PremiumErrorBoundary`, muro (`/subscription/suspended` → `/ayuda`), `PaymentPending` → `/ayuda` | ya usaban `canalSoporte()` | mismo canal, ahora con la regla estricta |
| Correos de Supabase Auth: `supabase/templates/confirmation.html` y `recovery.html` | «¿Necesitás ayuda? Escribinos a `<casilla>`» (`mailto:`) | «¿Necesitás ayuda? Escribinos por WhatsApp» → `wa.me` canónico (§6) |

**B · Legal / institucional / publisher → se mantiene**

| Uso | Motivo |
|---|---|
| `Privacidad.tsx` | política de privacidad (documento legal) |
| `LandingPage.tsx` · `mailto:` del pie (`VITE_CONTACT_EMAIL` o la constante) | contacto institucional publicado; tiene que coincidir con la política y con la ficha del Store |
| Ficha del Chrome Web Store (fuera del repo) | email verificado del publisher |
| Constante `CONTACTO_SOPORTE` | se conserva con ese nombre (histórico). Un test fija que en `src/` sólo la usan Privacidad y la landing; el guard de las plantillas de Auth la lee únicamente para detectar que reaparezca |

**C · Dudoso → reportado, NO modificado**

| Uso | Por qué no se tocó |
|---|---|
| `AuthContext.tsx:386` · «…Escribinos para que lo revisemos.» | Texto sin enlace; se ve en el bloque «Falta vincular este usuario a un negocio» de `MainLayout`. Es el núcleo de auth (fuera de alcance). El usuario en `link_failed` normalmente cae en `/no-business`, que ahora sí enlaza |
| `arcaSetupErrors.ts` · «contactá a soporte» (3 textos) | Sin enlace. ARCA está fuera de alcance; esa pantalla vive en `MainLayout`, con «Ayuda» en el menú |
| `VITE_CONTACT_EMAIL` en Vercel | Si está definida con otra casilla, el pie de la landing muestra esa. No verificable desde el repo |

---

## 3. Contrato nuevo

`src/config/contacto.ts` sigue siendo la **única autoridad**: es el único archivo que lee
`VITE_CONTACT_WHATSAPP` y el único que arma el enlace.

### 3.1 Formato

Configuración válida = celular argentino para `wa.me`: **`549` + 10 dígitos = 13 dígitos**
(`validarWhatsAppSoporte`).

| Valor | Resultado |
|---|---|
| `5493574404419` | válido (canónico) |
| `+54 9 3574 404419`, `+54 9 (3574) 40-4419` | válido: los separadores se descartan y se publica `5493574404419` |
| `594…` / `+594…` | **inválido** — «parece una transposición de 549» |
| `543574404419` (sin el 9) | **inválido** |
| truncado, con un dígito de más, otro país, número local | **inválido** |
| vacío, letras, una URL, basura pegada | **inválido** |

El formato legible se **tolera** en la variable porque lo que se publica es siempre el número
normalizado; lo que se rechaza son los errores de dígitos. El valor a cargar en Vercel es el canónico.
`normalizarWhatsApp()` queda como función genérica (E.164, 10–15 dígitos) y ya no decide el canal.

### 3.2 Canal

```ts
canalSoporte(motivo?) →
  | { tipo: 'whatsapp', url: 'https://wa.me/549…?text=…', etiqueta: 'Hablar por WhatsApp' }
  | { tipo: 'no_disponible', url: null, etiqueta: 'La ayuda por WhatsApp no está disponible en este momento.' }
```

- **Nunca** devuelve un `mailto:`.
- `no_disponible` es el respaldo defensivo (desarrollo sin la variable, o un error de configuración
  que el guard de build no haya visto): Ayuda muestra el aviso; las frases de las pantallas previas
  al negocio y de la pantalla de error directamente no se muestran. No se promete un contacto que no existe.

### 3.3 Mensaje precargado

`canalSoporte` recibe una **clave** de `MENSAJES_SOPORTE` (conjunto cerrado de textos fijos), no un
string libre: ningún componente puede interpolar el email del usuario, el nombre del negocio ni un id
en la URL. El texto va con `encodeURIComponent`.

---

## 4. Guard de build

Cómo se manejan hoy las variables: Vercel corre `npm run build` (= `vite build`, ver `vercel.json`) y
las `VITE_*` se inlinean en el bundle en ese momento. CI corre el mismo `npm run build` con valores
de relleno. No había ningún paso que mirara el valor.

El guard vive **dentro de Vite**, que es el único punto por el que pasan los tres caminos (Vercel,
CI y local), y lee la variable tal como Vite la resolvió — exactamente lo que quedaría en el bundle.

| Pieza | Rol |
|---|---|
| `validarWhatsAppSoporte` (`src/config/contacto.ts`) | la regla, una sola, compartida por runtime y build |
| `scripts/guards/support-contact-build.mjs` | política + plugin de Vite (`configResolved`, sólo en `build`) |
| `vite.config.ts` | cablea `supportContactGuard()` |
| `scripts/guards/support-contact.mjs` | CLI + self-test |

Política:

| Entorno | Valor ausente | Valor inválido |
|---|---|---|
| Vercel **Production** (`VERCEL_ENV=production`) | **el build falla** | **el build falla** |
| Preview, CI, local | aviso; la app muestra «no disponible» | **el build falla** |

Un valor inválido nunca es correcto, así que falla en cualquier entorno. Mensaje real:

```
GUARD support-contact: VITE_CONTACT_WHATSAPP empieza con 594 (Guayana Francesa): parece una
transposición de 549. Valor recibido: «5943…19» (13 dígitos).
Formato esperado: 549XXXXXXXXXX (13 dígitos: 54 + 9 + número nacional de 10).
```

`npm run guard:support-contact:self-test` (corre en CI) no se queda en la función pura: resuelve el
`vite.config.ts` **real** con cada valor (`resolveConfig`), así que también falla si alguien
descablea el plugin. Control negativo medido: quitando `supportContactGuard()` del config, el
self-test falla 5 casos.

Para probar un valor antes de cargarlo:

```bash
VITE_CONTACT_WHATSAPP=5493574404419 npm run guard:support-contact -- --production
```

---

## 5. Vercel — pasos del operador

Este PR **no** modifica Vercel.

1. Vercel → proyecto → **Settings → Environment Variables** → `VITE_CONTACT_WHATSAPP`:

   ```
   VITE_CONTACT_WHATSAPP=5493574404419
   ```

   Sólo dígitos: sin `+`, sin espacios, sin comillas.

2. Ambientes:
   - **Production — obligatorio.** Sin la variable, o con un valor inválido, el build productivo falla.
   - **Preview — recomendado**, con el mismo valor. Cada PR tiene su preview de Vercel: si Preview
     conserva el valor viejo (`+594…`), el preview de **cualquier** rama que ya tenga este guard
     falla; si no la tiene, el preview compila pero Ayuda dice «no disponible».
   - Development: opcional.

3. **Orden.** Corregir la variable **antes** de mergear. Si se mergea con el valor viejo, el build de
   producción falla y Vercel deja publicado el deployment anterior (no hay caída, pero sigue el
   número inválido y no sale ningún deploy nuevo hasta corregirla).

4. **Redeploy.** Cambiar una variable no altera los deployments existentes: hace falta un build nuevo.
   - Para corregir el número **hoy**, sin esperar este PR: Deployments → el de Production actual →
     **Redeploy**, con «Use existing Build Cache» **destildado**. El código actual ya normaliza bien
     un valor canónico.
   - Al mergear este PR, el deploy de `main` toma el valor nuevo por sí solo.

5. Verificación (sólo lectura), sobre el dominio productivo:
   - `/landing` → ícono de WhatsApp del pie → `https://wa.me/5493574404419?text=…`
   - `/ayuda` → «Hablar por WhatsApp» → el mismo número
   - en el bundle servido no queda ningún `wa.me/+` ni `594…`.

---

## 6. Correos de Supabase Auth

`supabase/templates/confirmation.html` (*Confirm signup*) y `recovery.html` (*Reset password*) decían
«¿Necesitás ayuda? Escribinos a `<casilla institucional>`». Ahora:

```html
¿Necesitás ayuda? <a href="https://wa.me/5493574404419?text=…">Escribinos por WhatsApp</a>.
```

| Plantilla | Mensaje precargado (fijo) |
|---|---|
| `confirmation.html` | `Hola, necesito ayuda para confirmar mi correo en TechRepair Pro.` |
| `recovery.html` | `Hola, necesito ayuda para restablecer mi contraseña de TechRepair Pro.` |

- El enlace es **estático**: no lleva ninguna variable de GoTrue (ni el email, ni el token), va con
  `encodeURIComponent` y no tiene parámetros de tracking.
- El flujo `token_hash` no cambió: el botón sigue siendo
  `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup|recovery`, sin `<img>` y sin dominios ajenos.
- La casilla institucional salió de las dos plantillas. Sigue en la política de privacidad, el pie de
  la landing y la ficha del Chrome Web Store.

### 6.1 El número está escrito en la plantilla — mantenerlo sincronizado

> **Las plantillas de Supabase Auth no leen `VITE_CONTACT_WHATSAPP`.** GoTrue renderiza un HTML
> estático: no tiene acceso a las variables de Vercel ni al bundle.

Por eso el WhatsApp de soporte es acá un **dato público versionado**, escrito en tres lugares que el
guard obliga a coincidir:

| Lugar | Qué tiene |
|---|---|
| `supabase/templates/confirmation.html`, `recovery.html` | el `href` completo |
| `scripts/guards/auth-email-templates.mjs` → `WHATSAPP_SOPORTE` y `PLANTILLAS[*].ayuda` | el número y los dos mensajes |

Y tiene que ser **el mismo valor** que `VITE_CONTACT_WHATSAPP=5493574404419` en Vercel. Eso último no
lo puede comprobar ningún test (la variable no vive en el repo): `betaUx1aSupportChannel` fija que el
número de las plantillas es el confirmado por el owner, y `supportContact` SC3b que cumple la misma
regla que la app.

**Si el número de soporte cambia**, son tres pasos, no uno:

1. `VITE_CONTACT_WHATSAPP` en Vercel (Production y Preview) + redeploy;
2. un PR que cambie el número en las dos plantillas y en `WHATSAPP_SOPORTE` (el guard falla si no
   coinciden entre sí);
3. volver a pegar las dos plantillas en Supabase Auth de producción (§6.3).

### 6.2 Guard

`npm run guard:auth-email-templates` (y su `:self-test`, los dos en CI):

- **T3** — la única URL `http(s)` literal y los únicos `href` admitidos son el enlace de Auth y el
  WhatsApp canónico **exacto** (número, mensaje y codificación). Sigue prohibido `<img>`.
- **T4** — la ayuda es ese enlace. Falla con cualquier `mailto:`, con cualquier casilla de correo
  (como enlace o como texto; si es la institucional, lo dice), con `api.whatsapp.com` /
  `web.whatsapp.com`, y con un `wa.me` que no sea el canónico: otro número, `594…`, con `+`, sin
  mensaje, con el mensaje sin codificar, con `{{ .Email }}` interpolado o con `utm_*`.
- T1, T2, T5, C1 y S1 (enlace `token_hash`, sin legacy, copy, config local, `src/`) no cambiaron.

Control negativo medido: el guard nuevo, corrido contra las plantillas anteriores (`d75f932`), da 3
hallazgos en cada una (`mailto` como ayuda, falta el WhatsApp canónico, volvió la casilla institucional).

Los E2E `password-recovery.spec.ts` (#1) y `email-verification.spec.ts` (#6) leen el correo **real**
que GoTrue manda en el stack local y comprueban que trae el enlace de ayuda versionado tal cual, y
ninguna casilla.

### 6.3 Sincronización a Supabase Auth de producción (operador)

Este PR **no** toca el Dashboard de Supabase. Mergearlo cambia el stack local y los tests, **no** los
correos de producción: esos siguen diciendo lo que esté pegado en el Dashboard hasta hacer esto.

Es el mismo procedimiento manual de PRE-BETA-2E (`docs/pre-beta-2/pre-beta-2e-auth-production-rollout.md`).
Ese registro confirma que *Reset password* se reemplazó por el archivo versionado, pero dejó «sin
registro» si *Confirm signup* tiene el copy versionado: conviene pegar **las dos**.

No depende del deploy del frontend ni de Vercel (el enlace es un `wa.me` estático): se puede hacer
apenas esté mergeado.

1. Tomar los archivos de `main`, ya mergeado (no de la rama).
2. Supabase Dashboard → proyecto de producción → **Authentication → Emails → Templates**.
3. ***Confirm signup***
   - copiar el *Body* (y el *Subject*) actuales a un lugar seguro: es el rollback;
   - reemplazar el *Body* **entero** por el contenido de `supabase/templates/confirmation.html`;
   - *Subject*: `Confirmá tu correo — TechRepair Pro`;
   - guardar.
4. ***Reset password***: igual, con `supabase/templates/recovery.html` y el *Subject*
   `Restablecé tu contraseña — TechRepair Pro`.
5. No tocar nada más: Redirect URLs, Site URL, SMTP ni las otras plantillas.
6. **Smoke inmediato**, con una cuenta QA:
   - alta nueva → llega el correo → el pie dice «¿Necesitás ayuda? Escribinos por WhatsApp» y abre
     un chat con `+54 9 3574 404419` y el mensaje precargado → «Confirmar mi correo» lleva a
     `https://www.techrepairpro.app/auth/callback?token_hash=…&type=signup` y confirma la cuenta;
   - «¿Olvidaste tu contraseña?» → mismo pie → «Elegir una contraseña nueva» lleva a
     `…/auth/callback?token_hash=…&type=recovery` y abre `/reset-password`;
   - en ninguno de los dos aparece la casilla de Gmail.
7. **Rollback**: pegar el texto guardado en el paso 3/4. No requiere deploy.
8. Dejar registro (fecha y resultado del smoke) en este documento.

**Estado: PENDIENTE — no ejecutado.**

---

## 7. Tests

| # | Requisito | Dónde |
|---|---|---|
| 1 | número productivo correcto | `betaUx1aSupportChannel` N · self-test |
| 2 | transposición `594` rechazada | N · C · self-test (regla, política y build real) |
| 3 | celular argentino sin `9` rechazado por el guard productivo | N · self-test («Production + sin 9») |
| 4 | `canalSoporte` devuelve WhatsApp cuando está configurado | C |
| 5 | no cae al Gmail por configuración faltante | C · `beta1SubscriptionWall` · `beta1Ayuda` · `inactiveProfile` I5b · `authUxHardening` V2 |
| 6 | pantallas pre-negocio usan el canal canónico | P · `inactiveProfile` I5 · `authUxHardening` V1, L8b |
| 7 | mensaje URL-encoded | M |
| 8 | sin datos personales / de tenant en el mensaje | M · P · G (clave literal) · L8b |
| 9 | auth / onboarding siguen verdes | suites existentes de PRE-BETA-2D, 3A-0, 3A-1a, BETA-1 |
| 10 | correos de Auth: WhatsApp canónico, mensaje fijo y codificado, sin correo | `guard:auth-email-templates` (+ self-test) · `supportContact` SC3/SC3b/SC3c · `betaUx1aSupportChannel` U |
| 11 | el correo real trae el enlace versionado, sin casilla | E2E `password-recovery` #1 · `email-verification` #6 (GoTrue + Mailpit locales) |

Control de fuente (G): sólo `contacto.ts` lee la variable; el número no está escrito en `src/`; la
casilla institucional sólo la usan Privacidad y la landing; las superficies de ayuda no tienen
`mailto:` ni arman `wa.me`; el build sigue cableado al guard.

Contratos que **cambiaron a propósito** (tests reescritos, no relajados):

- `beta1SubscriptionWall` y `beta1Ayuda`: «sin WhatsApp cae al correo» → «no cae al correo».
- `inactiveProfile` I5 y `authUxHardening` V1: el soporte canónico era el `mailto:`; ahora es WhatsApp.
- `tests/unit/authErrors` A4: el copy de `email_send_failed` ya no trae ninguna casilla.
- `supportContact` SC3 y los dos E2E de correo: afirmaban que el correo traía la casilla
  institucional; ahora afirman el WhatsApp canónico y que no hay ninguna casilla.

---

## 8. Fuera de alcance (no tocado)

Mercado Pago, billing, onboarding/provisioning, roles, ARCA, caja/POS, schema, migraciones y textos
legales. De Auth sólo cambió el pie de ayuda de las dos plantillas: el contrato `token_hash`, los
asuntos, las Redirect URLs y el resto de la configuración quedan igual. El correo de invitación
(Edge `send-business-invitation`) no trae contacto de soporte y no se tocó. El rubro opcional y
multiselección queda para otro lote.
