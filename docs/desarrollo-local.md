# Desarrollo local

## El camino único

```bash
npx supabase start        # 1. levantar el stack local
npx supabase status       # 2. copiar "API URL" y "anon key"
```

3. Crear **`.env.development.local`** (gitignoreado) declarando **las dos** variables:

```
VITE_SUPABASE_URL=http://127.0.0.1:55421
VITE_SUPABASE_ANON_KEY=<la anon key que muestra supabase status>
```

```bash
npm run dev               # 4. levantar la app
```

El preflight imprime el destino verificado antes de arrancar Vite:

```
✅ Destino local verificado · modo=development · host=127.0.0.1 · puerto=55421 · anon key=presente
```

Si no ves esa línea, **la app no está corriendo contra tu stack local**.

## Por qué el preflight existe

`npm run dev` era `vite` a secas. Vite carga `.env`, y en las máquinas de desarrollo ese archivo
apunta al Supabase **productivo**: el camino obvio para levantar la app servía la UI contra la base
viva. Ahora `npm run dev` valida el destino y **aborta antes de servir nada** si no es local.

La validación es la misma de la suite E2E (`motivoDeRechazo` en
`tests/e2e/setup/assertLocalTarget.ts`): una sola autoridad, para que no existan dos reglas que
puedan divergir.

## Las dos variables van juntas, siempre

Vite resuelve las variables **de a una**: si `.env.development.local` declara sólo la URL, la
`ANON_KEY` se hereda de `.env` y terminás con una configuración mezclada. El preflight exige que
**ambas** estén declaradas en el archivo local y aborta si falta alguna:

```
.env.development.local no declara VITE_SUPABASE_ANON_KEY. Vite completaría esas
variables desde `.env`, que apunta a producción.
```

## Reglas

- **Nunca** usar `.env` productivo para desarrollo.
- **Nunca** probar escrituras locales contra producción. Para mirar producción se usa el **dominio
  desplegado**, no una app local conectada a la base viva.
- **Nunca** desactivar el guard ni agregar un script que saltee el preflight. Si el guard rechaza un
  destino local legítimo (por ejemplo un puerto nuevo), la corrección es **agregarlo explícitamente**
  a `PUERTOS_PERMITIDOS`, no evitar la validación.

## Puertos

El Kong del stack local de este repo expone **55421** (`docker ps` sobre
`supabase_kong_techrepair-vite`), aunque `npx supabase status` informe otro. Si el tuyo difiere,
tomá el valor real de `docker ps` y agregalo a `PUERTOS_PERMITIDOS` en `assertLocalTarget.ts`.

## E2E

`npm run dev:e2e` usa el mismo preflight con `.env.e2e`, más el marker de entorno
(`e2e_environment_marker`) que verifica `npm run e2e:prepare`. Un host local **sin** marker no
alcanza: alguien podría tunelizar producción a `127.0.0.1`.

## Deuda conocida

En Windows, `npm install` falla con `EBADPLATFORM` por `@rollup/rollup-linux-x64-gnu`, que está en
`dependencies` para el build de Vercel (Linux). **`npm install --force` no es la solución**: es un
rodeo temporal. La corrección —mover esa dependencia a `optionalDependencies` u `overrides`— es un
P1 separado que debe verificarse en CI Linux antes de aplicarse.
