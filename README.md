# TechRepair Pro - Vite + React

Sistema de gestión para taller técnico/celulares reconstruido con React + Vite.

## Estructura del Proyecto

```
techrepair-vite/
├── src/
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   └── TopHeader.tsx
│   │   └── order/
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── Orders.tsx
│   │   ├── OrderDetail.tsx
│   │   ├── Customers.tsx
│   │   ├── CustomerDetail.tsx
│   │   ├── Inventory.tsx
│   │   ├── Suppliers.tsx
│   │   ├── Expenses.tsx
│   │   ├── Finance.tsx
│   │   ├── Reports.tsx
│   │   ├── Users.tsx
│   │   ├── CustomerPortal.tsx
│   │   └── Login.tsx
│   ├── layouts/
│   │   └── MainLayout.tsx
│   ├── data/
│   │   └── mockData.ts
│   ├── lib/
│   │   └── supabase.ts
│   ├── styles/
│   │   └── index.css
│   ├── App.tsx
│   ├── main.tsx
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .env.example
```

## Rutas Implementadas

- `/` - Dashboard
- `/dashboard` - Dashboard
- `/orders` - Lista de órdenes
- `/orders/:id` - Detalle de orden
- `/customers` - Lista de clientes
- `/customers/:id` - Detalle de cliente
- `/inventory` - Inventario
- `/suppliers` - Proveedores
- `/expenses` - Gastos
- `/finance` - Finanzas
- `/reports` - Reportes
- `/users` - Usuarios
- `/customer-portal` - Portal del cliente
- `/login` - Login

## Características

✅ **Stack Tecnológico:**
- React 18 + TypeScript
- Vite (build tool)
- React Router DOM
- Bootstrap 5 (CDN)
- Supabase (preparado)
- Lucide React (iconos)

✅ **UI/UX:**
- Tema dark premium índigo
- Sidebar navegable
- Cards modernas
- Tablas con datos mock
- Formularios estilizados
- Badges semánticos
- Responsive

✅ **Datos:**
- Mock data centralizada
- Tipos TypeScript definidos
- Helper functions incluidos

## Instalación

```bash
# 1. Navegar al directorio
cd techrepair-vite

# 2. Instalar dependencias
npm install

# 3. Crear archivo .env
copy .env.example .env
# Editar .env con tus credenciales de Supabase

# 4. Iniciar servidor de desarrollo
npm run dev
```

## Scripts Disponibles

```bash
npm run dev      # Iniciar servidor de desarrollo
npm run build    # Compilar para producción
npm run preview  # Previsualizar build de producción
```

## Variables de Entorno

Crear archivo `.env`:

```env
VITE_SUPABASE_URL=your_supabase_url_here
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

## Configuración Supabase

El cliente Supabase está preparado en `src/lib/supabase.ts`.

Tipos definidos:
- Order
- Customer
- Device
- Note
- PartUsed
- InventoryItem
- User

Para conectar con tu base de datos, reemplaza las llamadas mock en los componentes por llamadas reales a Supabase.

## Próximos Pasos

1. **Autenticación:** Implementar auth con Supabase
2. **Backend:** Crear tablas en Supabase siguiendo los tipos definidos
3. **Real-time:** Activar suscripciones realtime para actualizaciones en vivo
4. **Búsqueda:** Implementar filtros y búsqueda en tablas
5. **Notificaciones:** Agregar toasts para feedback

## Tema Visual

- **Background:** #0a0e1a
- **Surface:** #1a1f2e, #1e293b, #2d3748
- **Primary:** #6366f1 (índigo)
- **Success:** #10b981
- **Warning:** #f59e0b
- **Danger:** #dc2626
- **Text:** #f8fafc (principal), #a0aec0 (muted)

## Notas

- Este es un proyecto limpio reconstruido desde cero
- No depende de la estructura anterior
- Datos mock centralizados en `src/data/mockData.ts`
- Navegación funcional entre todas las páginas
- Diseño responsive con Bootstrap 5
"# TechRepair-Pro"  
"# TechRepair-Pro"  
