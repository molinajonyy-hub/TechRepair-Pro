# ORDERS-V2-0 · Discovery (sin implementación)

Dos investigaciones que ORDERS-V2-0 **no** ejecuta. Se documentan acá para que
el bloque que las tome no vuelva a empezar de cero.

Baseline: `de2cb887d8ca34da26365d149449f295937b7f43`.
Sin migraciones, sin cambios de esquema, sin tocar SEC-08.

---

## 9 · Identidad del técnico

### Las dos columnas

| Columna | FK | Origen | Índice |
|---|---|---|---|
| `orders.technician_id` | `public.users(id)` `ON DELETE SET NULL` | `20260628190324_remote_baseline.sql:11241` | `idx_orders_technician_id` |
| `orders.assigned_profile_id` | `public.profiles(id)` `ON DELETE SET NULL` | `20260903120000_mobile2a_order_intake.sql:20` | ninguno |

### Quién escribe

| Columna | Escritores |
|---|---|
| `assigned_profile_id` | **Sólo** `create_order_intake` (`20260903120000:447`). El cliente lo manda en `intakePayload` (`features/order-intake/model.ts:75`) y la RPC lo valida contra `profiles` del mismo negocio y activo (`:414-419`) antes de escribirlo. |
| `technician_id` | **Ningún código de aplicación.** Sólo `supabase/seed.sql` (datos de desarrollo) y scripts de `supabase/_archive/loose-scripts/`. En producción nada lo escribe hoy. |

### Quién lee

| Columna | Consumidores |
|---|---|
| `technician_id` | `useOrderSimple.ts:247` y `:412` → `supabase.from('users').select('id, name')` → `order.technician.name` → `OrderPrintPreviewModal.tsx:27` → `ServiceOrderPrint.tsx:340` («Téc: X» en la hoja). También `useOrder.ts:28` y `Reports.tsx:497` (agrupa producción por nombre de técnico). |
| `assigned_profile_id` | **Nadie lo muestra.** Está en las listas de columnas operativas (`orderService.ts:8`, `useOrderSimple.ts:21`, `api.ts:347`, `useOrder.ts:37`) y autorizado por SEC-08A (`20260911120000:73`), pero ninguna superficie lo renderiza. `NewOrder.tsx:185` muestra el nombre desde estado local, antes de crear. |

### El bug de producto, con la cadena completa

El alta escribe `assigned_profile_id`. El detalle, la impresión y Reportes leen
`technician_id`. Como nada escribe `technician_id`, **el técnico que se asigna
en la recepción no aparece en ninguna pantalla posterior**: el resumen del
wizard lo muestra, se guarda, y después se pierde de vista.

No es deuda estética. Es un dato que el usuario carga y el producto no le
devuelve.

### Por qué la autoridad futura tiene que ser `assigned_profile_id`

`public.users` es una tabla **anterior a la multi-tenencia**:

```sql
CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" uuid, "name" text NOT NULL, "email" text NOT NULL,
    "role" text NOT NULL, "phone" text, "active" boolean DEFAULT true,
    "created_at" timestamptz, "created_by" uuid,
    CONSTRAINT "users_role_check" CHECK (role IN ('admin','technician','receptionist'))
);
```

- **No tiene `business_id`.** No hay forma de acotarla por tenant, ni siquiera
  en principio.
- Su `role` (`admin`/`technician`/`receptionist`) no es el RBAC vigente, que
  vive en `profiles.permissions` + capabilities.
- Ninguna migración posterior al baseline la toca: quedó congelada.

`profiles`, en cambio, es la identidad canónica del producto (P0-ONBOARDING-1 /
P0-P6 RBAC), tiene `business_id`, y es contra la que `create_order_intake`
valida al asignar.

> **Hallazgo de seguridad — no es de este lote.**
> La policy del baseline es `CREATE POLICY "users_select" ON "public"."users"
> FOR SELECT TO "authenticated" USING (true)`. Sin `business_id` en la tabla,
> cualquier usuario autenticado puede leer `name`, `email`, `phone` y `role` de
> **todas** las filas, de cualquier tenant. No se verificó si hay datos en
> producción.
>
> Esto es superficie SEC-08 y **no se tocó**. Corresponde a Codex decidir si
> entra en un lote de seguridad. Orders V2 no debe modificar policies.

### Estrategia de migración propuesta (para un bloque posterior)

Orden sugerido, cada paso desplegable por separado:

1. **Backfill de lectura, sin escribir.** Una vista o expresión que resuelva el
   responsable como `COALESCE(assigned_profile_id, <mapeo de technician_id>)`.
   El mapeo `users → profiles` sólo es posible por `email`, y sin `business_id`
   en `users` un mismo email podría resolver a más de un profile: hay que tratar
   la colisión como **no mapeable**, nunca elegir uno.
2. **Mover los lectores.** `useOrderSimple`, `useOrder`, `Reports` y la
   impresión pasan a leer `profiles` vía `assigned_profile_id`.
   ⚠️ `useOrderSimple.ts` es archivo **mixto SEC-08** (contiene la llamada a
   `get_order_financial_amounts`): este paso espera a que SEC-08E/F cierre.
3. **Habilitar la escritura fuera del alta.** Hoy sólo se puede asignar al
   crear; reasignar desde el detalle necesita su propia RPC o un UPDATE
   acotado a `assigned_profile_id`.
4. **Retirar `technician_id`.** Recién cuando (2) esté desplegado y verificado.
   La columna se deja como está mientras tanto: borrarla antes rompería
   Reportes e impresión para las órdenes históricas.

### Compatibilidad de órdenes existentes

- Las órdenes previas a MOBILE-2A tienen `assigned_profile_id IS NULL`. Si un
  lector nuevo mira sólo esa columna, **pierden el técnico** que hoy muestran.
  Por eso el paso 1 es un `COALESCE`, no un reemplazo.
- Las órdenes creadas por el wizard tienen `assigned_profile_id` poblado y
  `technician_id NULL`.
- No hay órdenes con las dos columnas pobladas, porque nada escribe las dos.

---

## 10 · Reutilización de equipos (dedupe)

### Cómo está hoy

`create_order_intake` hace, siempre, un `INSERT` nuevo
(`20260903120000:440-445`): **una fila de `devices` por cada orden**. Un cliente
que trae el mismo teléfono tres veces genera tres equipos distintos.

```sql
CREATE TABLE IF NOT EXISTS "public"."devices" (
    "id" uuid, "customer_id" uuid, "type" text NOT NULL,
    "brand" text NOT NULL, "model" text NOT NULL,
    "serial" text, "imei" text, "issue" text NOT NULL, "diagnosis" text,
    "business_id" uuid NOT NULL, ...
    CONSTRAINT devices_type_check CHECK (type IN
      ('smartphone','tablet','laptop','smartwatch','other'))
);
```

Datos duros:

- **No hay ningún constraint único.** Sólo índices en `business_id` y
  `customer_id`. Nada impide hoy dos equipos idénticos, ni lo impedirá después
  sin una migración.
- `serial` e `imei` son **nullable**. `issue` es `NOT NULL`.
- `orders.device_id` → `devices(id)` **`ON DELETE RESTRICT`**. Un equipo con
  órdenes no se puede borrar: los duplicados históricos **no se limpian
  borrando**, hay que consolidarlos repuntando `orders.device_id`.
- `devicesService.create` (`api.ts:611`) existe y **no lo usa nadie**: el único
  escritor vivo es la RPC. Eso simplifica el cambio — hay un solo lugar.

### El problema con `issue` en la clave

`devices.issue` guarda el problema reportado **de esa visita**. Si se reutiliza
la fila, la segunda orden pisaría el problema de la primera, y la impresión y
WhatsApp de la orden vieja pasarían a mostrar la falla nueva.

Consecuencia de diseño: **el equipo y el motivo de ingreso tienen que dejar de
compartir fila** antes de poder deduplicar. `issue` es de la orden, no del
equipo.

### Casos a resolver

| Caso | Qué hacer |
|---|---|
| IMEI y serial vacíos | **No deduplicar.** Sin identificador no hay identidad; marca+modelo no alcanza (un taller tiene veinte «Galaxy A04e»). Insertar fila nueva, como hoy. |
| Sólo serial | Deduplicar por `(business_id, customer_id, serial)`. |
| Sólo IMEI | Deduplicar por `(business_id, customer_id, imei)`. |
| Ambos | IMEI manda: es el identificador fuerte y está validado con Luhn en cliente y servidor. |
| Cambio de dueño | La clave **incluye `customer_id`**: el mismo IMEI con otro cliente es otra fila. Es lo correcto — el historial de reparación pertenece al equipo, pero la titularidad no debe cruzarse entre clientes. Ver «pendiente» abajo. |
| Mismo serial en categorías distintas | Los seriales cortos de fabricante se repiten entre tipos. La clave debe incluir `type`. |
| Serial escrito distinto | `SER-1` vs `ser 1`. Normalizar (trim + upper + sin separadores) como ya hace el catálogo con `normalized_name`. Sin normalizar, el dedupe no dedupe. |
| Duplicados históricos | Quedan. `ON DELETE RESTRICT` los protege; consolidarlos es un trabajo aparte y **no debe hacerse automáticamente**. |

### Forma propuesta (para un bloque posterior)

1. Columna generada o índice funcional con el identificador normalizado.
2. Índice único **parcial**:
   `UNIQUE (business_id, customer_id, type, normalized_identifier)
    WHERE normalized_identifier IS NOT NULL` — el `WHERE` es lo que deja
   convivir los equipos sin identificador, que son legítimos y frecuentes.
3. `create_order_intake` pasa de `INSERT` a *find-or-create* sobre esa clave,
   dentro de la misma transacción que ya tiene.
4. `issue` deja de escribirse en `devices` en el reuso; el motivo de ingreso de
   cada orden pasa a vivir del lado de la orden.

**Ninguno de estos cuatro pasos entra en ORDERS-V2-0.** El paso 3 modifica
`create_order_intake`, que es la autoridad de alta y tiene tests SQL propios
(`tests/sql/mobile2a_order_intake.test.sql`).

### Lo que desbloquea

- «Este equipo ya estuvo en el taller» y el historial por equipo.
- La quick action «equipos anteriores de este cliente» del paso 2 del wizard.
- Estadísticas por equipo real y no por fila-por-visita.

### Pendiente de decisión de producto

Si el mismo IMEI aparece con **otro cliente**, hoy se insertaría una fila nueva
y el taller no se entera. Un taller podría querer el aviso («este equipo entró
antes a nombre de otra persona») — que es útil contra equipos robados, y a la
vez es información de un tercero. **No resolver por defecto:** requiere decisión
explícita antes de implementarse.
