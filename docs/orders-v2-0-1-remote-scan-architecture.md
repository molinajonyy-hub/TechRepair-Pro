# ORDERS-V2-0.1 · Escaneo asistido por celular — arquitectura

Bloques C, D y E del pedido. Baseline `3b8406c`.

> **Estado: DISEÑADO, NO IMPLEMENTADO.** Al final se explica por qué y qué
> falta. El resto del lote (scanner cross-browser, combobox, money input) sí
> está implementado.

---

## 1 · Qué resuelve — y qué ya no

El caso original era: «en el escritorio no hay forma práctica de escanear».

Una parte de eso **ya quedó resuelta** por el bloque A/B de este mismo lote: la
compuerta rota era `!window.BarcodeDetector`, y con el motor de respaldo el
escritorio con webcam ahora escanea. Lo que el escaneo remoto agrega es el caso
que ninguna corrección local cubre: **la PC del mostrador no tiene cámara, o la
que tiene no alcanza para leer una etiqueta chica.**

Es decir: pasó de ser el arreglo del bug a ser una mejora sobre un flujo que ya
funciona. Eso cambia su urgencia, no su valor.

---

## 2 · Flujo

```
ESCRITORIO (autenticado)                    CELULAR (anónimo)
────────────────────────                    ─────────────────────
paso Identificación
"Escanear con el celular"
        │
        ▼
 rpc create_scan_session()
        │  ├─ exige capability orders_create
        │  ├─ business_id ← auth.uid(), NUNCA del payload
        │  ├─ token = 32 bytes CSPRNG
        │  ├─ guarda SÓLO sha256(token)
        │  └─ ttl 3 min · un solo valor aceptado
        ▼
 devuelve el token en claro (una vez)
        │
        ▼
   [ QR ]  https://app/s/<token>  ──── escanea ───►  página mínima
        │                                            (sin sesión, sin datos)
        │                                                   │
        │                                            pide cámara
        │                                            decodifica LOCALMENTE
        │                                                   ▼
        │                              POST /functions/v1/scan-relay
        │                                   Authorization: Bearer <token>
        │                                   { "value": "353412…" }
        │                              ┌────────────────┴──────────────────┐
        │                              │ EDGE FUNCTION · verify_jwt=FALSE  │
        │                              │  1 sha256(token) → sesión         │
        │                              │  2 no vencida · no consumida      │
        │                              │  3 value: ≤64 chars, [A-Za-z0-9-] │
        │                              │  4 rate limit por token y por IP  │
        │                              │  5 escribe value + consumed_at    │
        │                              └────────────────┬──────────────────┘
        │                                               ▼
        │◄──── poll cada 2 s mientras el QR está en pantalla ──┘
        ▼
  el valor aparece en el campo · la sesión queda consumida
```

El celular **decodifica en el teléfono** y manda sólo el string resultante. No
sube imágenes, así que no hay Storage involucrado ni foto que retener.

---

## 3 · Seguridad

Cada prohibición del pedido, y cómo la cumple el diseño:

| Prohibido | Cómo se evita |
|---|---|
| `business_id` confiado desde querystring | El QR no lo lleva. Se resuelve server-side desde el hash del token. |
| `user_id` confiado desde el browser | Ídem: sale de `auth.uid()` en el momento de crear la sesión. |
| IMEI dentro del QR | El QR se genera **antes** de escanear: no hay valor que poner. |
| `service_role` en el frontend | La clave vive sólo en la Edge Function. |
| Tokens predecibles | 32 bytes CSPRNG; en la DB sólo el `sha256`. El texto plano existe únicamente en el QR en pantalla. |

Propiedades de la sesión:

- **Aleatoria** — 256 bits.
- **Single-purpose** — el único verbo es «entregar un valor escaneado».
- **TTL corto** — 3 minutos. El QR está en pantalla mientras se usa.
- **Revocable** — cerrar el diálogo la marca consumida.
- **Consumo único** — el primer valor la cierra. Semántica explícita, no
  «último gana»: dos teléfonos no pueden pisarse.
- **Ligada al tenant en el backend** — nunca por parámetro.
- **Sin permisos adicionales** — el token no es una credencial de sesión.

Lo que el teléfono con el token **no** puede hacer: leer la orden, leer el
cliente, enumerar el tenant, consultar nada. La Edge Function expone un solo
endpoint de escritura y no devuelve datos del negocio: sólo `{ ok: true }`.

---

## 4 · Qué se investigó antes de elegir (bloque E)

| Opción | Por qué no |
|---|---|
| **Supabase Realtime broadcast** con nombre de canal aleatorio como token | Sin migración, pero el teléfono necesita la anon key (que es pública) y la autorización queda apoyada sólo en que el nombre del canal no se adivine. No hay TTL, ni consumo único, ni revocación, ni vínculo con el tenant. Es exactamente la «arquitectura frágil» que el bloque E pide evitar. |
| **Reusar `private.order_intake_photo_sessions`** | No existe: fue diseñada en el discovery de Orders V2 pero nunca se implementó. |
| **Reusar `comprobante_checkout_idempotency`** | Semántica distinta (idempotencia de escritura), y meter un segundo propósito adentro la vuelve ambigua. |
| **Tabla dedicada + 2 RPC SECDEF + Edge Function** | **Elegida.** Es lo mínimo que cumple las seis propiedades de arriba. |

No hay solución segura sin migración. El pedido es explícito: «NO sacrificar
seguridad sólo para evitar una migration».

---

## 5 · Superficie a crear

```sql
-- migración NUEVA, timestamp posterior al head actual (20260921120000)
create table private.remote_scan_sessions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  created_by   uuid not null,
  token_hash   bytea not null unique,      -- sha256; NUNCA el token
  value        text,                       -- lo que entregó el teléfono
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
-- RLS FORCE + REVOKE ALL a anon/authenticated/service_role,
-- igual que private.order_device_access_secrets.
```

- `public.create_scan_session()` — SECDEF, exige `orders_create`.
- `public.read_scan_session(uuid)` — SECDEF, sólo del propio tenant.
- Edge Function `scan-relay` — `verify_jwt = FALSE` **declarado explícitamente
  en el deploy**: el default del CLI es `TRUE` y rompería el flujo.
- `pg_cron` diario para borrar vencidas. Corre como `postgres`.

### Foundation reutilizable

La misma sesión sirve después para el QR de fotos: cambia el *payload* (un
archivo en vez de un string) y el destino (Storage en vez de una columna), no
el modelo de sesión ni el de token. **Las fotos no se implementan acá**, según
el bloque P.

---

## 6 · Por qué no se implementó en este lote

1. **Agrega una superficie de producción sin autenticar.** Merece su propia
   revisión de seguridad y sus propios controles negativos (token de otro
   tenant, token vencido, token reusado, valor sobredimensionado), no ir de
   arrastre en un lote cuyo objetivo era corregir tres regresiones del human
   smoke.
2. **Necesita una migración mientras Codex tiene migraciones SEC-08 en vuelo.**
   El pedido pide coordinar; coordinar no es adivinar el timestamp libre.
3. **La urgencia bajó.** El bloque A/B ya devolvió el escaneo en escritorio con
   webcam y en el celular del técnico. El caso que queda —PC sin cámara— tiene
   como alternativa hoy escanear desde el celular directamente en la misma
   pantalla de alta.
4. Lo que sí queda listo: el decodificador es el mismo módulo
   (`barcodeScanning.ts`) que usaría la página del teléfono, así que ese lote
   escribe transporte y seguridad, no scanner.

**Recomendación:** ORDERS-V2-0.2, con revisión de seguridad propia y
coordinación de timestamp con Codex.
