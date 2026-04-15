# Plan de Testing - TechRepair Vite

## ✅ Checklist de Funcionalidades

### 1. Autenticación
- [ ] Login con credenciales válidas
- [ ] Login con credenciales inválidas (mensaje de error)
- [ ] Cierre de sesión
- [ ] Protección de rutas (no acceder sin login)

### 2. Dashboard
- [ ] Carga de estadísticas reales
- [ ] Stats cards muestran datos correctos
- [ ] Lista de órdenes recientes
- [ ] Gráfico de órdenes por estado
- [ ] Botón "Actualizar" recarga datos
- [ ] Manejo de error si falla carga

### 3. Órdenes (Lista)
- [ ] Carga lista de órdenes desde Supabase
- [ ] Filtros funcionan
- [ ] Búsqueda funciona
- [ ] Paginación (si aplica)
- [ ] Link a detalle de orden

### 4. Detalle de Orden
- [ ] Carga datos reales de la orden
- [ ] Muestra cliente, dispositivo, estado
- [ ] Cambio de estado con validaciones:
  - [ ] No permite transiciones inválidas
  - [ ] Bloquea si falta checklist para "Completada"
  - [ ] Bloquea si hay saldo pendiente
  - [ ] Bloquea si falta firma de retiro
- [ ] Registro en historial al cambiar estado
- [ ] Notificación automática al cambiar estado

### 5. Pagos (PaymentCard)
- [ ] Muestra saldo pendiente correcto
- [ ] Agregar pago actualiza el total
- [ ] Eliminar pago funciona
- [ ] Recalcula automáticamente
- [ ] Múltiples métodos de pago

### 6. Checklist (ChecklistCard)
- [ ] Crear nuevo checklist
- [ ] Editar checklist existente
- [ ] Marcar tareas como completadas
- [ ] Barra de progreso se actualiza
- [ ] Guardar firma de retiro

### 7. Notificaciones
- [ ] Dropdown muestra notificaciones
- [ ] Badge con contador de no leídas
- [ ] Marcar como leída funciona
- [ ] Marcar todas como leídas funciona
- [ ] Nueva notificación aparece en tiempo real
- [ ] Link a orden relacionada funciona

### 8. Clientes
- [ ] Lista de clientes carga
- [ ] Crear nuevo cliente
- [ ] Editar cliente
- [ ] Búsqueda de clientes

### 9. Documentos
- [ ] Subir documento/Imagen
- [ ] Ver preview de imagen
- [ ] Eliminar documento
- [ ] Lista de documentos de la orden

### 10. Reportes
- [ ] Gráficos renderizan correctamente
- [ ] Datos reales en reportes
- [ ] Filtros por fecha funcionan

## 🔧 Comandos para Testing

```bash
# Iniciar servidor de desarrollo
npm run dev

# Verificar build
npm run build

# Verificar TypeScript
npx tsc --noEmit

# Verificar linting
npm run lint
```

## 🐛 Bugs Conocidos / Por Verificar

1. **TypeScript errors**: Algunos imports no usados en Dashboard.tsx
2. **RLS Policies**: Verificar que las políticas de Supabase permitan operaciones
3. **Foreign Keys**: Verificar relaciones entre tablas

## ✅ Tests Exitosos

Marca con ✅ cuando funcione:

```
✅ Dashboard carga estadísticas reales
✅ Cambio de estado guarda en historial  
✅ Notificaciones aparecen automáticamente
...
```
