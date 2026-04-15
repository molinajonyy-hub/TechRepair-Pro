-- =========================================================
-- DATOS INICIALES DE MARCAS Y MODELOS POPULARES
-- =========================================================
-- Este script carga marcas y modelos populares para todos los negocios existentes
-- Ejecutar después de crear las tablas brands y device_models

-- Función para cargar datos iniciales para un negocio específico
CREATE OR REPLACE FUNCTION public.seed_brands_models_for_business(p_business_id UUID)
RETURNS VOID AS $$
DECLARE
  v_brand_id UUID;
BEGIN
  -- Apple
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Apple', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('iPhone 15 Pro Max', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 15 Pro', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 15', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 15 Plus', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 14 Pro Max', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 14 Pro', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 14', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 14 Plus', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 13 Pro Max', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 13 Pro', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 13', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 13 Mini', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 12 Pro Max', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 12 Pro', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 12', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 12 Mini', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 11 Pro Max', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 11 Pro', v_brand_id, p_business_id, auth.uid()),
      ('iPhone 11', v_brand_id, p_business_id, auth.uid()),
      ('iPhone SE 2022', v_brand_id, p_business_id, auth.uid()),
      ('iPhone SE 2020', v_brand_id, p_business_id, auth.uid()),
      ('iPad Pro 12.9"', v_brand_id, p_business_id, auth.uid()),
      ('iPad Pro 11"', v_brand_id, p_business_id, auth.uid()),
      ('iPad Air', v_brand_id, p_business_id, auth.uid()),
      ('iPad Mini', v_brand_id, p_business_id, auth.uid()),
      ('iPad', v_brand_id, p_business_id, auth.uid()),
      ('MacBook Pro 16"', v_brand_id, p_business_id, auth.uid()),
      ('MacBook Pro 14"', v_brand_id, p_business_id, auth.uid()),
      ('MacBook Air', v_brand_id, p_business_id, auth.uid()),
      ('Apple Watch Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Apple Watch Series 9', v_brand_id, p_business_id, auth.uid()),
      ('Apple Watch SE', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Samsung
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Samsung', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('Galaxy S24 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S24+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S24', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S23 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S23+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S23', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S22 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S22+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S22', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S21 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S21+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S21', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S20 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S20+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy S20', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Note 20 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Note 20', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy A54', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy A34', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy A24', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Z Fold 5', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Z Flip 5', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Tab S9 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Tab S9+', v_brand_id, p_business_id, auth.uid()),
      ('Galaxy Tab S9', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Xiaomi
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Xiaomi', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('Xiaomi 14 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 14 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 14', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 13 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 13 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 13', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 12 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Xiaomi 12', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 13 Pro+', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 13 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 13', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 12 Pro+', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 12 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Redmi Note 12', v_brand_id, p_business_id, auth.uid()),
      ('POCO F5 Pro', v_brand_id, p_business_id, auth.uid()),
      ('POCO F5', v_brand_id, p_business_id, auth.uid()),
      ('POCO X5 Pro', v_brand_id, p_business_id, auth.uid()),
      ('POCO X5', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Motorola
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Motorola', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('Moto Edge 40 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Moto Edge 40 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Moto Edge 40', v_brand_id, p_business_id, auth.uid()),
      ('Moto Edge 30 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Moto Edge 30 Fusion', v_brand_id, p_business_id, auth.uid()),
      ('Moto Edge 30', v_brand_id, p_business_id, auth.uid()),
      ('Moto G54', v_brand_id, p_business_id, auth.uid()),
      ('Moto G53', v_brand_id, p_business_id, auth.uid()),
      ('Moto G52', v_brand_id, p_business_id, auth.uid()),
      ('Moto G42', v_brand_id, p_business_id, auth.uid()),
      ('Moto G32', v_brand_id, p_business_id, auth.uid()),
      ('Moto G23', v_brand_id, p_business_id, auth.uid()),
      ('Moto G13', v_brand_id, p_business_id, auth.uid()),
      ('Razr 40 Ultra', v_brand_id, p_business_id, auth.uid()),
      ('Razr 40', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Huawei
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Huawei', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('P60 Pro', v_brand_id, p_business_id, auth.uid()),
      ('P60', v_brand_id, p_business_id, auth.uid()),
      ('Mate 50 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Mate 50', v_brand_id, p_business_id, auth.uid()),
      ('P50 Pro', v_brand_id, p_business_id, auth.uid()),
      ('P50', v_brand_id, p_business_id, auth.uid()),
      ('Nova 11 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Nova 11', v_brand_id, p_business_id, auth.uid()),
      ('MatePad Pro 13.2"', v_brand_id, p_business_id, auth.uid()),
      ('MatePad Pro 11"', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- LG
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('LG', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('LG Velvet', v_brand_id, p_business_id, auth.uid()),
      ('LG V60', v_brand_id, p_business_id, auth.uid()),
      ('LG G8X', v_brand_id, p_business_id, auth.uid()),
      ('LG Stylo 6', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Sony
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Sony', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('Xperia 1 V', v_brand_id, p_business_id, auth.uid()),
      ('Xperia 1 IV', v_brand_id, p_business_id, auth.uid()),
      ('Xperia 5 V', v_brand_id, p_business_id, auth.uid()),
      ('Xperia 10 V', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Oppo
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Oppo', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('Find X6 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Find X6', v_brand_id, p_business_id, auth.uid()),
      ('Reno 10 Pro+', v_brand_id, p_business_id, auth.uid()),
      ('Reno 10 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Reno 10', v_brand_id, p_business_id, auth.uid()),
      ('A78', v_brand_id, p_business_id, auth.uid()),
      ('A58', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Vivo
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Vivo', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('X90 Pro+', v_brand_id, p_business_id, auth.uid()),
      ('X90 Pro', v_brand_id, p_business_id, auth.uid()),
      ('X90', v_brand_id, p_business_id, auth.uid()),
      ('V29 Pro', v_brand_id, p_business_id, auth.uid()),
      ('V29', v_brand_id, p_business_id, auth.uid()),
      ('Y78', v_brand_id, p_business_id, auth.uid()),
      ('Y28', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- Realme
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('Realme', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('GT 5 Pro', v_brand_id, p_business_id, auth.uid()),
      ('GT 5', v_brand_id, p_business_id, auth.uid()),
      ('GT Neo 3', v_brand_id, p_business_id, auth.uid()),
      ('Number 11 Pro+', v_brand_id, p_business_id, auth.uid()),
      ('Number 11 Pro', v_brand_id, p_business_id, auth.uid()),
      ('Number 11', v_brand_id, p_business_id, auth.uid()),
      ('C55', v_brand_id, p_business_id, auth.uid()),
      ('C53', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
  -- OnePlus
  INSERT INTO public.brands (name, business_id, created_by)
  VALUES ('OnePlus', p_business_id, auth.uid())
  ON CONFLICT (name, business_id) DO NOTHING
  RETURNING id INTO v_brand_id;
  
  IF v_brand_id IS NOT NULL THEN
    INSERT INTO public.device_models (name, brand_id, business_id, created_by)
    VALUES 
      ('OnePlus 12', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus 11', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus 10 Pro', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus 10', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus Ace 2 Pro', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus Ace 2', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus Nord CE 3', v_brand_id, p_business_id, auth.uid()),
      ('OnePlus Nord 3', v_brand_id, p_business_id, auth.uid())
    ON CONFLICT (name, brand_id, business_id) DO NOTHING;
  END IF;
  
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant ejecución de la función
GRANT EXECUTE ON FUNCTION public.seed_brands_models_for_business(UUID) TO authenticated;

-- NOTA: Esta función está disponible para ser ejecutada manualmente si se desea
-- cargar datos de ejemplo para un negocio específico. NO se ejecuta automáticamente
-- para mantener el sistema limpio para nuevos usuarios.
