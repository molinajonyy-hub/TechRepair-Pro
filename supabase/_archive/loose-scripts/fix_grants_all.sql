-- ================================================================
-- GRANTS PARA EL ROL authenticated EN TODAS LAS TABLAS
-- Sin GRANT no hay acceso aunque RLS diga USING(true)
-- ================================================================

-- Tablas financieras principales
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_finance_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_movements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_registers TO authenticated;

-- Comprobantes y pagos
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comprobantes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comprobante_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comprobante_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_webhook_events TO authenticated;

-- Órdenes
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_parts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_checklists TO authenticated;

-- Clientes y dispositivos
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.devices TO authenticated;

-- Inventario
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_movements TO authenticated;

-- Compras y proveedores
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;

-- Gastos
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO authenticated;

-- Mercado Pago
GRANT SELECT ON public.mp_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_method_buttons TO authenticated;

-- Sales points
GRANT SELECT, INSERT, UPDATE ON public.sales_points TO authenticated;

-- Garantías, tareas, notificaciones
GRANT SELECT, INSERT, UPDATE, DELETE ON public.warranties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;

-- Historial y notas
GRANT SELECT, INSERT ON public.status_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;

-- Configuración
GRANT SELECT ON public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.business_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.exchange_rates TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;

-- WhatsApp
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_connections TO authenticated;
GRANT SELECT, INSERT ON public.whatsapp_logs TO authenticated;
GRANT SELECT, INSERT ON public.whatsapp_message_logs TO authenticated;

-- Otros
GRANT SELECT ON public.subscription_events TO authenticated;
GRANT SELECT, INSERT ON public.device_inspections TO authenticated;

-- Sequences (para los DEFAULT gen_random_uuid() y similares)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
