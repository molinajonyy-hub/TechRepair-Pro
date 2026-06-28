-- ============================================
-- SISTEMA DE NOTIFICACIONES
-- ============================================

-- Tabla de notificaciones
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Quién recibe la notificación
  user_id UUID REFERENCES auth.users(id),
  
  -- Tipo y contenido
  type VARCHAR(50) NOT NULL, -- 'status_change', 'payment_received', 'new_order', 'reminder'
  title VARCHAR(255) NOT NULL,
  message TEXT,
  
  -- Datos relacionados
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  
  -- Estado
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadatos adicionales (JSON)
  metadata JSONB,
  
  -- Fechas
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Índices
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_order_id ON notifications(order_id);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);

-- ============================================
-- FUNCIÓN PARA CREAR NOTIFICACIONES
-- ============================================

CREATE OR REPLACE FUNCTION create_notification(
  p_user_id UUID,
  p_type VARCHAR,
  p_title VARCHAR,
  p_message TEXT,
  p_order_id UUID DEFAULT NULL,
  p_customer_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_notification_id UUID;
BEGIN
  INSERT INTO notifications (
    user_id,
    type,
    title,
    message,
    order_id,
    customer_id,
    metadata
  ) VALUES (
    p_user_id,
    p_type,
    p_title,
    p_message,
    p_order_id,
    p_customer_id,
    p_metadata
  )
  RETURNING id INTO v_notification_id;
  
  RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGER: Notificación automática al cambiar estado
-- ============================================

CREATE OR REPLACE FUNCTION notify_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_customer_name VARCHAR;
  v_old_status_label VARCHAR;
  v_new_status_label VARCHAR;
  v_user_id UUID;
BEGIN
  -- Obtener nombre del cliente
  SELECT name INTO v_customer_name
  FROM customers
  WHERE id = (
    SELECT customer_id FROM orders WHERE id = NEW.order_id
  );
  
  -- Obtener labels de estados
  v_old_status_label := CASE NEW.from_status
    WHEN 'new' THEN 'Nueva'
    WHEN 'diagnosis' THEN 'Diagnóstico'
    WHEN 'waiting_approval' THEN 'Esperando Aprobación'
    WHEN 'repair' THEN 'En Reparación'
    WHEN 'waiting_parts' THEN 'Esperando Repuestos'
    WHEN 'ready_delivery' THEN 'Listo para Entregar'
    WHEN 'waiting_payment' THEN 'Esperando Pago'
    WHEN 'completed' THEN 'Completada'
    WHEN 'cancelled' THEN 'Cancelada'
    ELSE NEW.from_status
  END;
  
  v_new_status_label := CASE NEW.to_status
    WHEN 'new' THEN 'Nueva'
    WHEN 'diagnosis' THEN 'Diagnóstico'
    WHEN 'waiting_approval' THEN 'Esperando Aprobación'
    WHEN 'repair' THEN 'En Reparación'
    WHEN 'waiting_parts' THEN 'Esperando Repuestos'
    WHEN 'ready_delivery' THEN 'Listo para Entregar'
    WHEN 'waiting_payment' THEN 'Esperando Pago'
    WHEN 'completed' THEN 'Completada'
    WHEN 'cancelled' THEN 'Cancelada'
    ELSE NEW.to_status
  END;
  
  -- Crear notificación para el usuario que hizo el cambio
  IF NEW.changed_by IS NOT NULL THEN
    PERFORM create_notification(
      NEW.changed_by,
      'status_change',
      'Estado actualizado',
      format('La orden de %s cambió de "%s" a "%s"', 
        COALESCE(v_customer_name, 'cliente'),
        v_old_status_label,
        v_new_status_label
      ),
      NEW.order_id,
      NULL,
      jsonb_build_object(
        'from_status', NEW.from_status,
        'to_status', NEW.to_status,
        'changed_by', NEW.changed_by,
        'notes', NEW.notes
      )
    );
  END IF;
  
  -- Aquí se podrían agregar más notificaciones:
  -- - Notificar al técnico asignado
  -- - Notificar al cliente (por email/SMS)
  -- - Notificar a administradores
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para notificar cambios de estado
DROP TRIGGER IF EXISTS notify_on_status_change ON status_history;
CREATE TRIGGER notify_on_status_change
  AFTER INSERT ON status_history
  FOR EACH ROW
  EXECUTE FUNCTION notify_status_change();

-- ============================================
-- FUNCIÓN: Marcar notificación como leída
-- ============================================

CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE notifications
  SET 
    is_read = true,
    read_at = now()
  WHERE id = p_notification_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- VISTA: Notificaciones no leídas por usuario
-- ============================================

CREATE OR REPLACE VIEW unread_notifications AS
SELECT 
  n.*,
  c.name as customer_name,
  o.status as order_status
FROM notifications n
LEFT JOIN customers c ON n.customer_id = c.id
LEFT JOIN orders o ON n.order_id = o.id
WHERE n.is_read = false
ORDER BY n.created_at DESC;

-- ============================================
-- POLÍTICAS RLS
-- ============================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Usuarios solo ven sus propias notificaciones
CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Solo el sistema puede insertar notificaciones
CREATE POLICY "System can insert notifications"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Usuarios pueden actualizar sus notificaciones (marcar como leída)
CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());
