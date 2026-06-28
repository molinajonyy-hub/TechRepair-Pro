# Módulo de Comprobantes y Facturación

Módulo completo de comprobantes y facturación preparado para integración con AFIP (ARCA).

## 📦 Estructura Creada

### Backend (Supabase)

```
supabase/_archive/loose-scripts/comprobantes_schema.sql    # Tablas, funciones y políticas RLS
```

**Tablas creadas:**
- `comprobantes` - Almacena cabecera de comprobantes
- `comprobante_items` - Items/detalle de cada comprobante
- Campo `comprobante_id` agregado a tabla `orders`

**Funciones SQL:**
- `generar_numero_comprobante()` - Genera numeración
- `recalcular_totales_comprobante()` - Recalcula totales automáticamente

### Frontend

```
src/
├── services/
│   └── facturacionService.ts       # Servicio de facturación + mock AFIP
├── hooks/
│   ├── useComprobantes.ts          # Hook para CRUD de comprobantes
│   └── index.ts                    # Exports actualizados
├── components/comprobantes/
│   ├── ComprobanteHeader.tsx       # Header tipo factura
│   ├── ComprobanteInfo.tsx         # Info cliente y datos AFIP
│   ├── ComprobanteItemsTable.tsx   # Tabla editable de items
│   ├── ComprobanteTotales.tsx      # Subtotal, IVA, Total
│   ├── ComprobanteActions.tsx      # Botones emitir/anular/PDF
│   ├── ModalGenerarComprobante.tsx # Modal crear desde orden
│   └── index.ts                    # Exports
└── pages/
    └── Comprobante.tsx             # Página detalle comprobante
```

## 🚀 Instalación

### 1. Ejecutar SQL en Supabase

Ir a Supabase SQL Editor y ejecutar:

```sql
-- Copiar y pegar todo el contenido de:
supabase/_archive/loose-scripts/comprobantes_schema.sql
```

### 2. Instalar dependencia para PDF (opcional)

```bash
npm install jspdf jspdf-autotable
# o
yarn add jspdf jspdf-autotable
```

### 3. Rutas ya configuradas

En `App.tsx` ya se agregó:
```tsx
<Route path="/comprobantes/:id" element={<Comprobante />} />
```

## ✅ Funcionalidades Implementadas

### Tipos de Comprobante
- ✅ **Factura A** - Con IVA 21% discriminado
- ✅ **Factura C** - Sin IVA discriminado
- ✅ **Remito** - No afecta contabilidad
- ✅ **Nota de Crédito** - Para devoluciones

### Estados
- `borrador` - Editable, no emitido
- `emitido` - Emitido en AFIP (mock)
- `anulado` - Anulado

### Características
- ✅ Crear comprobante desde orden
- ✅ Editar items (si está en borrador)
- ✅ Recálculo automático de totales
- ✅ Emitir comprobante (mock AFIP)
- ✅ Generar CAE fake
- ✅ Descargar PDF
- ✅ Anular comprobante
- ✅ Integración en OrderDetail

## 🔌 Mock AFIP (ARCA)

El servicio `afipService` simula:

```typescript
// Generar CAE fake
const cae = afipService.generarCAEFake();

// Solicitar CAE (con delay simulado)
const response = await afipService.solicitarCAE(comprobante);

// Respuesta incluye:
{
  success: true,
  cae: '7...',
  caeVencimiento: '2024-...',
  numero: '0001-00000001',
  response: { ... }
}
```

## 🎯 Para Integrar AFIP Real

Cuando estés listo para conectar con AFIP real:

1. **Implementar en `services/facturacionService.ts`:**

```typescript
export const afipService = {
  async getToken(): Promise<string> {
    // Implementar OAuth2 con AFIP
    const wsaa = new Wsaa({ ... });
    return wsaa.getToken();
  },
  
  async emitirFacturaReal(data: any): Promise<any> {
    // Usar librería @afipsdk/afip.js o similar
    const afip = new Afip({ ... });
    return afip.ElectronicBilling.createVoucher({
      ...datosComprobante
    });
  }
};
```

2. **Reemplazar llamada mock:**

En `facturacionService.ts`, línea ~250:
```typescript
// Cambiar esto:
const afipResponse = await afipService.solicitarCAE(comprobante);

// Por esto:
const afipResponse = await afipService.emitirFacturaReal(datosAfip);
```

## 📱 Cómo Usar

### Generar Comprobante desde Orden

1. Ir a detalle de orden `/orders/:id`
2. Click en botón **"Generar Comprobante"**
3. Seleccionar tipo (Factura A/C, Remito, Nota Crédito)
4. Configurar punto de venta
5. Click **"Generar Comprobante"**

### Ver Comprobante

1. Desde OrderDetail: click **"Ver Comprobante"**
2. O navegar directamente: `/comprobantes/:id`

### Emitir en AFIP (Mock)

1. En página de comprobante (estado: borrador)
2. Click **"Emitir en AFIP"**
3. Esperar respuesta mock (1.5 segundos)
4. Se genera CAE y número automáticamente

### Descargar PDF

1. Comprobante debe estar en estado "emitido"
2. Click **"Descargar PDF"**
3. PDF generado con formato profesional

## 🧪 Testing

### Crear comprobante de prueba:

```typescript
import { facturacionService } from './services/facturacionService';

const result = await facturacionService.crearComprobante({
  order_id: 'uuid-orden',
  customer_id: 'uuid-cliente',
  tipo: 'factura_a',
  punto_venta: '0001',
  condicion_fiscal: 'Responsable Inscripto',
  items: [
    {
      descripcion: 'Servicio técnico',
      cantidad: 1,
      precio_unitario: 10000
    }
  ]
});
```

### Emitir comprobante:

```typescript
const result = await facturacionService.emitirComprobante('uuid-comprobante');
console.log(result.comprobante?.cae); // CAE generado
```

## 🎨 Diseño

- Estilo dark índigo consistente con el sistema
- Layout tipo factura real profesional
- Responsive para móvil
- Iconos de Lucide React

## ⚠️ Consideraciones

- **Para desarrollo**: RLS habilitado con políticas permisivas
- **Para producción**: Implementar AFIP real antes de emitir
- **Alícuota IVA**: Actualmente 21% para Factura A
- **Punto de venta**: Debe estar habilitado en AFIP real

## 📚 Referencias

- [AFIP SDK para Node.js](https://github.com/afipsdk/afip.js)
- [Documentación ARCA](https://www.arca.gob.ar/)
- [WSFE (Factura Electrónica)](https://servicios1.afip.gov.ar/wsfev1/)

---

**Listo para usar!** 🚀
