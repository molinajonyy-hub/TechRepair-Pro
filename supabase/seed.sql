-- Seed data adicional para dispositivos y órdenes
-- Ejecutar después de crear las tablas

-- Dispositivos de ejemplo
INSERT INTO devices (customer_id, type, brand, model, serial, imei, issue) 
SELECT 
    c.id,
    'smartphone',
    'Apple',
    'iPhone 13 Pro',
    'ABC123456789',
    '351234567890123',
    'Pantalla rota, no enciende'
FROM customers c 
WHERE c.name = 'Juan Pérez';

INSERT INTO devices (customer_id, type, brand, model, serial, imei, issue)
SELECT 
    c.id,
    'smartphone',
    'Samsung',
    'Galaxy S21',
    'DEF987654321',
    '351987654321098',
    'No carga, problema de batería'
FROM customers c 
WHERE c.name = 'María García';

INSERT INTO devices (customer_id, type, brand, model, serial, imei, issue, diagnosis)
SELECT 
    c.id,
    'tablet',
    'Apple',
    'iPad Pro 12"',
    'GHI456789123',
    '351456789123456',
    'Pantalla con líneas, touch no responde',
    'Falla en el controlador táctil, requiere reemplazo de pantalla'
FROM customers c 
WHERE c.name = 'Carlos López';

INSERT INTO devices (customer_id, type, brand, model, serial, imei, issue)
SELECT 
    c.id,
    'smartphone',
    'Xiaomi',
    'Redmi Note 11',
    'JKL789123456',
    '351789123456789',
    'Cámara trasera no funciona'
FROM customers c 
WHERE c.name = 'Ana Martínez';

-- Órdenes de ejemplo
INSERT INTO orders (customer_id, device_id, technician_id, status, priority, estimated_total, labor_cost)
SELECT 
    c.id,
    d.id,
    (SELECT id FROM users WHERE name = 'Técnico A'),
    'repair',
    'high',
    450,
    150
FROM customers c
JOIN devices d ON d.customer_id = c.id
WHERE c.name = 'Juan Pérez' AND d.model = 'iPhone 13 Pro';

INSERT INTO orders (customer_id, device_id, technician_id, status, priority, estimated_total, labor_cost)
SELECT 
    c.id,
    d.id,
    (SELECT id FROM users WHERE name = 'Técnico B'),
    'diagnosis',
    'medium',
    0,
    50
FROM customers c
JOIN devices d ON d.customer_id = c.id
WHERE c.name = 'María García' AND d.model = 'Galaxy S21';

INSERT INTO orders (customer_id, device_id, technician_id, status, priority, estimated_total, labor_cost, total_cost)
SELECT 
    c.id,
    d.id,
    (SELECT id FROM users WHERE name = 'Técnico A'),
    'ready_delivery',
    'low',
    320,
    100,
    320
FROM customers c
JOIN devices d ON d.customer_id = c.id
WHERE c.name = 'Carlos López' AND d.model = 'iPad Pro 12"';

INSERT INTO orders (customer_id, device_id, technician_id, status, priority)
SELECT 
    c.id,
    d.id,
    NULL,
    'new',
    'high'
FROM customers c
JOIN devices d ON d.customer_id = c.id
WHERE c.name = 'Ana Martínez' AND d.model = 'Redmi Note 11';

-- Repuestos usados en órdenes
INSERT INTO parts_used (order_id, code, description, quantity, unit_price)
SELECT 
    o.id,
    'SCR-IPH13P',
    'Pantalla iPhone 13 Pro OLED',
    1,
    280
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO parts_used (order_id, code, description, quantity, unit_price)
SELECT 
    o.id,
    'BAT-IPH13P',
    'Batería iPhone 13 Pro',
    1,
    45
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO parts_used (order_id, code, description, quantity, unit_price)
SELECT 
    o.id,
    'SCR-SAM21',
    'Pantalla Samsung S21',
    1,
    220
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'María García';

-- Notas en órdenes
INSERT INTO notes (order_id, author, text, is_internal)
SELECT 
    o.id,
    'Técnico A',
    'Diagnóstico inicial: Pantalla impactada, posible daño en placa base. Se recomienda reemplazo completo.',
    true
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO notes (order_id, author, text, is_internal)
SELECT 
    o.id,
    'Técnico B',
    'Reemplazo de pantalla completado, probando funcionalidad. Todo OK.',
    true
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO notes (order_id, author, text, is_internal)
SELECT 
    o.id,
    'Recepcionista',
    'Cliente notificado por WhatsApp que el equipo está listo para retiro.',
    false
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Carlos López';

-- Historial de estados
INSERT INTO status_history (order_id, status, note)
SELECT 
    o.id,
    'new',
    'Orden creada'
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO status_history (order_id, status, note)
SELECT 
    o.id,
    'diagnosis',
    'Diagnóstico completado'
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';

INSERT INTO status_history (order_id, status, note)
SELECT 
    o.id,
    'repair',
    'En proceso de reparación'
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.name = 'Juan Pérez';
