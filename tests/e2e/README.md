# TechRepair Pro — Tests E2E con Playwright

## Instalación

```bash
# Instalar dependencias (Playwright ya está en devDependencies)
npm install

# Instalar browsers de Playwright
npx playwright install chromium
```

## Variables de entorno requeridas

Copiar `.env.test.example` a `.env.test` y completar:

```
E2E_BASE_URL=http://localhost:5173   # URL del dev server
E2E_EMAIL=qa@techrepair.test         # Email del usuario QA
E2E_PASSWORD=QA_password_here        # Contraseña del usuario QA
```

Variables opcionales (para tests que requieren comprobantes específicos):

```
E2E_COMPROBANTE_ID_EFECTIVO=<uuid>   # Comprobante pagado efectivo $1000
E2E_COMPROBANTE_ID_MIXTO=<uuid>      # Comprobante con pago mixto $500+$500
E2E_NOTA_CREDITO_ID=<uuid>           # ID de una nota de crédito
```

**NUNCA commitear `.env.test` con credenciales reales.**

## Cómo correr

```bash
# Primero: levantar el dev server en otra terminal
npm run dev

# Correr todos los tests
npm run test:e2e

# Modo interactivo (UI mode)
npm run test:e2e:ui

# Con browser visible
npm run test:e2e:headed

# Solo tests @smoke
npm run test:e2e -- --grep @smoke

# Solo tests @finance
npm run test:e2e -- --grep @finance

# Debug paso a paso
npm run test:e2e:debug
```

## Tests disponibles

| Archivo | Tags | Descripción | Seguro en producción |
|---------|------|-------------|---------------------|
| `auth-navigation.spec.ts` | `@smoke` | Login + navegación básica | ✅ Solo lectura |
| `customer-inventory.spec.ts` | `@smoke` | Crear cliente/producto E2E | ⚠️ Crea datos E2E |
| `editar-cobro-unico.spec.ts` | `@finance` | Editar cobro único (BUG-01) | ⚠️ Requiere ID env |
| `editar-cobro-mixto.spec.ts` | `@finance` | Editar cobro mixto (BUG-01) | ⚠️ Requiere ID env |
| `expenses-atomic.spec.ts` | `@finance` | Gastos atómicos (INF-02) | ⚠️ Crea datos E2E |
| `nota-credito.spec.ts` | `@finance` | Widget NC correcto | ⚠️ Requiere ID env |

## Usuario QA

Crear en Supabase Auth un usuario específico para tests:
- Email: `qa@techrepair.test` (o similar)
- Debe tener un negocio configurado
- No usar cuentas de negocio real

## Convenciones

- Todo dato creado por tests usa prefijo **`E2E `** (ej: `E2E Cliente 1A2B3C`)
- Los datos E2E pueden acumularse — limpiarlos manualmente o con script de cleanup
- Tests con `test.fixme()` necesitan variables de entorno adicionales
- No correr tests `@finance` ni `@stock` contra producción sin datos aislados

## Crear datos de prueba para tests con .fixme

Para activar los tests que usan IDs específicos:
1. Crear comprobantes de prueba desde la app
2. Copiar sus IDs desde la URL
3. Agregarlos a `.env.test`:
   ```
   E2E_COMPROBANTE_ID_EFECTIVO=<uuid-del-comprobante>
   E2E_COMPROBANTE_ID_MIXTO=<uuid-del-comprobante-mixto>
   E2E_NOTA_CREDITO_ID=<uuid-de-nc>
   ```
