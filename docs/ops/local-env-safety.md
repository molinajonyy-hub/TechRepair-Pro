# Seguridad de entorno local — no le pegues a producción sin querer

## El problema

El archivo **`.env`** (local, **no versionado** — está en `.gitignore`) suele contener la
URL de la Supabase de **producción**:

```
VITE_SUPABASE_URL=https://<proyecto-prod>.supabase.co
```

Como Vite inyecta esas variables en `npm run dev` y `npm run build`, **correr la app local
sin override hace que la UI lea/escriba en PRODUCCIÓN**. Para un smoke financiero (abrir caja,
cobros, pagos, reversos) esto es peligroso: son escrituras reales al libro mayor.

## Por qué esto NO afecta a Vercel

`.env` **no está en el repo** (gitignored). Vercel **no** lo usa: toma sus variables del
**dashboard de Environment Variables** del proyecto (ver la nota en `.env.example`:
“No commitear IDs/datos reales: cargarlos en Vercel”). Por lo tanto:

- Cambiar o borrar tu `.env` local **no rompe** el build de Vercel.
- El único efecto de `.env` es sobre tu máquina de desarrollo.

## La forma segura de correr dev/smoke local

1. Levantá Supabase local: `npx supabase start` (y `npx supabase db reset` para aplicar migraciones).
2. Creá `.env.local` a partir de la plantilla (tiene prioridad sobre `.env` y está gitignored):
   ```bash
   cp .env.local.example .env.local
   ```
   Debe apuntar a `http://127.0.0.1:54621` (confirmá el puerto con `npx supabase status`).
3. `npm run dev`.
4. **Verificá la pestaña Network ANTES de operar:** toda request de datos debe ir a
   `127.0.0.1:54621`. **Si ves `*.supabase.co`, PARÁ** — estás contra producción.
5. Al terminar, borrá `.env.local` (o dejalo; nunca se commitea).

## Reglas

- **Nunca** corras un smoke financiero contra producción.
- **Nunca** commitees `.env` ni `.env.local` (ambos gitignored; verificá con `git check-ignore .env .env.local`).
- Los valores reales de prod viven en el **dashboard de Vercel**, no en el repo.

## TODO (commit ops posterior, cuando se confirme el env de Vercel)

Cuando se confirme que Vercel tiene sus env vars propias (Supabase URL/anon key de prod
en el dashboard), considerar **sacar la URL de producción del `.env` de las máquinas de dev**
y dejar `.env` apuntando a local por defecto — para que el default seguro sea local y prod
sea el caso explícito. Este cambio es operativo (máquinas de dev / plantillas), **no** de
código de la app, y va en un commit `chore(env)` separado, nunca mezclado con features.
