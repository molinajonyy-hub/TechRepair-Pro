# P0-SAFEDEV — El desarrollo local es fail-closed · informe

**Fecha:** 2026-07-31 · Rama `fix/p0a1-order-completion-payment-status` · commit nuevo **`4bb56e8`**
Los siete commits previos quedaron intactos. **No publicado, sin PR, sin deploy, sin migraciones, sin tocar RPCs ni Health Check.**

---

## 1. Causa exacta

`npm run dev` era literalmente `vite`. Vite en modo *development* carga `.env`, y en las máquinas de desarrollo ese archivo contiene la URL del Supabase **productivo**. Nada validaba el destino: la seguridad dependía de que el operador **se acordara** de usar `dev:e2e`.

**Matiz importante que corrige la premisa del pedido:** `.env` **no está versionado** — `.gitignore` lo excluye junto con `.env.local` y `.env.*.local`; en el repo sólo viven los `.example`. Así que no había un secreto commiteado ni un destino productivo en el repositorio. El defecto era exclusivamente **la ausencia de validación** en el script por defecto. Por eso §5 del pedido (limpiar `.env` versionado) no aplicó: no hay nada que limpiar.

## 2. Precedencia anterior

Vite en modo `development` carga, de menor a mayor prioridad:
`.env` → `.env.development` → `.env.local` → `.env.development.local`.

Como sólo existía `.env` (productivo), ese era el destino efectivo. Ahora el camino local se configura en **`.env.development.local`**, que gana por precedencia y está gitignoreado.

## 3. Estrategia elegida

**Opción C del pedido: una utilidad común.** Un preflight que corre antes de Vite y **reutiliza el validador de 7D.2** en lugar de crear uno nuevo.

## 4. Scripts antes / después

| | Antes | Después |
|---|---|---|
| `dev` | `vite` | `node scripts/dev/preflight-local.mjs development && vite --mode development` |
| `dev:e2e` | `vite --mode e2e …` | `node scripts/dev/preflight-local.mjs e2e && vite --mode e2e …` |
| `build` · `vercel-build` | sin cambios | **sin cambios** |

El `&&` importa: el preflight es **precondición**, no un proceso paralelo. Un test lo verifica explícitamente. No se creó ningún `dev:prod` ni equivalente.

## 5. Guard reutilizado

`motivoDeRechazo()` de **`tests/e2e/setup/assertLocalTarget.ts`** — el mismo de 7D.2. Ahora es autoridad compartida por `dev`, `dev:e2e`, `e2e:prepare` y la config de Playwright. **No hay un segundo validador que pueda divergir.**

El preflight carga las variables con **`loadEnv(modo, raíz, '')`**, o sea con la semántica real de Vite para ese modo. Es la diferencia entre validar lo que Vite **va a usar** y validar `process.env`, que no vería el `.env` en absoluto.

**Un cambio en el guard compartido:** se agregó **`55421`** a los puertos permitidos. Es el que realmente expone el Kong de este repo (`supabase_kong_techrepair-vite` mapea `0.0.0.0:55421->8000`), mientras que `supabase status` informa 54421. Sin esa ampliación el preflight rechazaba el stack local legítimo, y un guard que rechaza lo correcto termina desactivado. Queda documentado en el código como ampliación deliberada.

## 6. Destinos permitidos

Hostname por **igualdad exacta** contra `localhost`, `127.0.0.1`, `::1`, `[::1]`, y puerto dentro de una lista explícita. Se rechazan: dominios `.supabase.co`/`.supabase.in`, cualquier host remoto, IP privadas de red, túneles tipo ngrok, y URLs malformadas.

## 7. Comportamiento fail-closed

Aborta con exit 1 **antes de levantar Vite** si: la URL falta o está vacía, no es local, usa un puerto fuera de política, o falta `VITE_SUPABASE_ANON_KEY`. El mensaje enmascara el host (`vrdx…ase.co`) y **nunca** imprime la anon key, el service role ni ningún token. En el camino feliz informa sólo modo, host y puerto.

## 8. Archivos de entorno

No se tocó ningún `.env` real ni ninguna variable de Vercel, y no se rotó ninguna clave. El camino local usa `.env.development.local`, gitignoreado (verificado con `git check-ignore`). Los `.example` versionados ya traían placeholders.

## 9. Compatibilidad con Vercel

`build` y `vercel-build` **no invocan el preflight**: un build productivo no puede exigir un Supabase local. Hay un test que lo fija, para que nadie agregue el preflight ahí "por consistencia" y rompa el deploy. `npm run build` local: **OK**.

## 10. Tests — 15 nuevos, todos verdes

Destino gestionado · host remoto genérico · IP privada · túnel · URL ausente/vacía · localhost y 127.0.0.1 y `[::1]` válidos · **hostnames parecidos pero remotos** (`localhost.example.com`, `127.0.0.1.example.com`, `localhost.supabase.co`) · validación por igualdad y no por substring (se verifica que no exista un `.includes()` sobre el hostname) · puerto fuera de política · URL malformada · **ningún mensaje contiene JWT, service role ni el host completo** · `dev` no corre vite sin preflight · ningún script `dev*` sin validación y ningún `dev:prod` · el build no depende del preflight · el preflight reutiliza el guard y usa `loadEnv` · `.gitignore` sigue excluyendo los `.env` reales.

**Sobre §10 (guard con self-test):** el guard está implementado como **tests de contrato en la suite existente**, no como un `.mjs` aparte con `--self-test`. Cumple la función —fallan si `dev` vuelve a ejecutar `vite` sin preflight, si aparece un script de desarrollo sin validación o si el validador pasa a comparar por substring— y evita un tercer mecanismo de verificación. Es una desviación consciente del formato pedido; si preferís el script separado, es mecánico de mover.

## 11. Prueba manual

| Caso | Resultado |
|---|---|
| **A** — sin variables locales (gana `.env` productivo) | **aborta**, exit 1, «El destino es un Supabase gestionado (vrdx…ase.co)» |
| **B** — destino remoto de prueba (`localhost.example.com`) | **aborta**, exit 1, antes de Vite |
| **C** — stack local en `.env.development.local` | preflight **OK**: `host=127.0.0.1 · puerto=55421 · anon key=presente` |

## 12. Evidencia de cero tráfico productivo

En A y B el proceso **termina antes de que Vite arranque**, así que no hay servidor, no hay bundle y no hay una sola request. No es una inferencia: el exit code es 1 y la salida del preflight es lo último que se imprime.

El recorrido visual del lote anterior ya había confirmado, con la app corriendo, que el tráfico iba al Kong local (`http://127.0.0.1:55421/auth/v1/health` respondía desde el navegador y el login funcionó contra la base de Docker).

## 13. Hallazgo abierto — precedencia parcial de variables

Al probar el caso «falta la anon key» descubrí que **Vite completa variable por variable**: si `.env.development.local` define sólo `VITE_SUPABASE_URL`, la `ANON_KEY` se hereda de `.env` (productivo) y el preflight la ve presente, así que **no aborta**.

No hay fuga de datos —manda la URL, y la app habla con el Supabase local; una anon key productiva ni siquiera valida contra el JWT secret local—, pero es una mezcla confusa y **el contrato §2.C no queda cumplido al pie de la letra**. La corrección natural es que el preflight compare el origen de cada variable y exija que ambas provengan del archivo local. **No lo implementé**: lo detecté al final del lote y prefiero declararlo antes que agregar lógica sin probarla bien.

Ese fue también el motivo de un tropiezo operativo: el caso C original colgó 10 minutos porque, al pasar el preflight, **Vite arrancó de verdad**. Maté el proceso y restauré el archivo local; `git status` confirma que no quedó nada suelto.

## 14. Validación

`tsc` 0 · `lint:errors` 0 · **587/587** unit (572 previos + 15 nuevos) · **18/18** componentes · `build` OK · `guards` OK · **`supabase/` intacto, cero migraciones** · secret scan limpio · sin accesos a producción y sin escrituras.

## 15. Archivos

| Archivo | Cambio |
|---|---|
| `scripts/dev/preflight-local.mjs` | **nuevo** — preflight fail-closed |
| `package.json` | `dev` y `dev:e2e` pasan por el preflight |
| `tests/e2e/setup/assertLocalTarget.ts` | +puerto 55421, documentado |
| `tests/unit/safeDevPreflight.test.ts` | **nuevo** — 15 tests |

## 16. Riesgos

- **Fricción esperada y deseada:** quien hoy corre `npm run dev` sin `.env.development.local` va a ver un aborto. Es el punto del lote, pero conviene avisarlo al equipo.
- **Hallazgo §13 abierto**: la herencia parcial de variables desde `.env`.
- **Bajo:** el puerto local quedó hardcodeado en una lista. Si el stack cambia de puerto hay que agregarlo a mano — deliberado, para que ampliar la superficie sea siempre un acto explícito.
- **Ninguno para Vercel:** el build no cambió y pasa.
- **Documentación (§11) no actualizada**: no toqué la guía de desarrollo. El mensaje de error del preflight ya contiene el camino de 4 pasos, que es donde el operador lo va a leer, pero la guía escrita sigue pendiente.

## 17. Recomendación

**GO a U2.**

El gate se cierra: el camino por defecto ya no puede apuntar a producción, y falla antes de servir nada. Con U2 escribiendo imputaciones y reversas, esa era la precondición importante.

Dos cosas para el próximo lote, ninguna bloqueante: cerrar el hallazgo §13 y actualizar la guía de desarrollo. El P1 de `EBADPLATFORM` sigue separado y **`npm install --force` no quedó documentado como solución**.
